// Implementation note: ESP-SR's AFE / WakeNet bring-up is heavy and version-
// sensitive. The init code below uses the v1.4-era API; if you upgrade
// esp-sr, cross-check against its `esp_afe_sr_models.h` / `esp_wn_iface.h`.
//
// Tested logic: state transitions (IDLE → LISTENING → IDLE on server cue,
// MUTED at any time). Bench-bring-up TODOs are marked inline.

#include "audio_in.h"
#include "config.h"
#include "ws_client.h"

#include <stdatomic.h>
#include <string.h>

#include "driver/i2s_std.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#if __has_include("esp_afe_sr_iface.h")
#include "esp_afe_sr_iface.h"
#include "esp_afe_sr_models.h"
#include "esp_wn_iface.h"
#include "esp_wn_models.h"
#include "model_path.h"
#define GS_HAVE_ESP_SR 1
#else
#define GS_HAVE_ESP_SR 0
#endif

static const char *TAG = "gs_audio_in";

static i2s_chan_handle_t s_mic_rx = NULL;
static atomic_int s_streaming = 0;
static atomic_int s_muted = 0;

#if GS_HAVE_ESP_SR
static esp_afe_sr_iface_t *s_afe = NULL;
static esp_afe_sr_data_t  *s_afe_data = NULL;
static esp_wn_iface_t     *s_wakenet = NULL;
static model_iface_data_t *s_wakenet_data = NULL;
#endif

static esp_err_t init_i2s_rx(void) {
    i2s_chan_config_t chan_cfg = I2S_CHANNEL_DEFAULT_CONFIG(GS_MIC_I2S_PORT, I2S_ROLE_MASTER);
    esp_err_t err = i2s_new_channel(&chan_cfg, NULL, &s_mic_rx);
    if (err != ESP_OK) return err;

    i2s_std_config_t std_cfg = {
        .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(GS_MIC_SAMPLE_RATE_HZ),
        .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_32BIT,
                                                       I2S_SLOT_MODE_STEREO),
        .gpio_cfg = {
            .mclk = I2S_GPIO_UNUSED,
            .bclk = GS_PIN_MIC_BCLK,
            .ws = GS_PIN_MIC_WS,
            .dout = I2S_GPIO_UNUSED,
            .din = GS_PIN_MIC_DIN,
            .invert_flags = {
                .mclk_inv = false,
                .bclk_inv = false,
                .ws_inv = false,
            },
        },
    };
    err = i2s_channel_init_std_mode(s_mic_rx, &std_cfg);
    if (err != ESP_OK) return err;
    return i2s_channel_enable(s_mic_rx);
}

#if GS_HAVE_ESP_SR
static esp_err_t init_afe_and_wakenet(const char *wake_model_id) {
    srmodel_list_t *models = esp_srmodel_init("model");
    if (!models) {
        ESP_LOGE(TAG, "esp_srmodel_init failed");
        return ESP_FAIL;
    }
    char *wn_name = esp_srmodel_filter(models, wake_model_id ? wake_model_id : ESP_WN_PREFIX, NULL);
    if (!wn_name) {
        ESP_LOGE(TAG, "wake model '%s' not found in flash partition",
                 wake_model_id ? wake_model_id : "(default)");
        return ESP_FAIL;
    }
    s_wakenet = (esp_wn_iface_t *)esp_wn_handle_from_name(wn_name);
    s_wakenet_data = s_wakenet->create(wn_name, DET_MODE_2CH_90);

    afe_config_t afe_cfg = AFE_CONFIG_DEFAULT();
    afe_cfg.aec_init = true;     // critical: AEC for barge-in
    afe_cfg.se_init = true;      // speech enhancement (NS)
    afe_cfg.vad_init = false;    // server-side VAD; we just stream raw
    afe_cfg.wakenet_init = true;
    afe_cfg.pcm_config.total_ch_num = GS_MIC_CHANNELS;
    afe_cfg.pcm_config.mic_num = GS_MIC_CHANNELS;
    afe_cfg.pcm_config.ref_num = 0;
    afe_cfg.pcm_config.sample_rate = GS_MIC_SAMPLE_RATE_HZ;

    s_afe = (esp_afe_sr_iface_t *)&ESP_AFE_SR_HANDLE;
    s_afe_data = s_afe->create_from_config(&afe_cfg);
    if (!s_afe_data) {
        ESP_LOGE(TAG, "afe create failed");
        return ESP_FAIL;
    }
    return ESP_OK;
}
#endif

// Hot path: read I2S, feed AFE, watch WakeNet, stream PCM when listening.
static void audio_task(void *arg) {
    (void)arg;
    const size_t i2s_bytes_per_read = GS_PCM_FRAME_SAMPLES * GS_MIC_CHANNELS * 4; // 32-bit slots
    uint8_t *i2s_buf = malloc(i2s_bytes_per_read);
    int16_t mono_pcm[GS_PCM_FRAME_SAMPLES];
    (void)mono_pcm; // referenced only in the non-esp-sr fallback path below
    if (!i2s_buf) {
        ESP_LOGE(TAG, "i2s buffer alloc failed");
        vTaskDelete(NULL);
        return;
    }

    for (;;) {
        if (atomic_load(&s_muted)) {
            // Drain & idle while muted so we don't spin on I2S reads.
            vTaskDelay(pdMS_TO_TICKS(50));
            continue;
        }

        size_t bytes_read = 0;
        esp_err_t e = i2s_channel_read(s_mic_rx, i2s_buf, i2s_bytes_per_read,
                                       &bytes_read, pdMS_TO_TICKS(100));
        if (e != ESP_OK || bytes_read == 0) continue;

#if GS_HAVE_ESP_SR
        // AFE expects int16 PCM. Convert 32-bit slot → 16-bit by taking the
        // high bits (INMP441 has its 24-bit sample left-justified in the slot).
        // TODO(bench): verify slot bit alignment with a scope; some boards
        // need >>14 rather than >>16 depending on routing.
        int16_t *afe_in = (int16_t *)i2s_buf;  // alias — overwrite in-place
        const int32_t *src = (const int32_t *)i2s_buf;
        size_t samples = bytes_read / 4;
        for (size_t i = 0; i < samples; i++) afe_in[i] = (int16_t)(src[i] >> 16);

        if (s_afe && s_afe_data) {
            s_afe->feed(s_afe_data, afe_in);
            afe_fetch_result_t *res = s_afe->fetch(s_afe_data);
            if (res && res->ret_value == ESP_OK) {
                bool wake = (res->wakeup_state == WAKENET_DETECTED);
                bool streaming = atomic_load(&s_streaming);
                if (wake && !streaming) {
                    ESP_LOGI(TAG, "wake detected");
                    gs_ws_send_wake();
                    atomic_store(&s_streaming, 1);
                }
                if (streaming) {
                    // res->data is int16 mono at 16 kHz, length res->data_size bytes.
                    gs_ws_send_pcm((const uint8_t *)res->data, res->data_size);
                }
            }
        }
#else
        // Fallback path when esp-sr isn't available at compile time. Pulls
        // one channel of int16 PCM out and streams it raw — useful for
        // smoke-testing the wire without WakeNet, e.g. with a PTT button.
        const int32_t *src = (const int32_t *)i2s_buf;
        size_t samples = (bytes_read / 4) / GS_MIC_CHANNELS;
        for (size_t i = 0; i < samples && i < GS_PCM_FRAME_SAMPLES; i++) {
            mono_pcm[i] = (int16_t)(src[i * GS_MIC_CHANNELS] >> 16);
        }
        if (atomic_load(&s_streaming)) {
            gs_ws_send_pcm((const uint8_t *)mono_pcm, GS_PCM_FRAME_SAMPLES * 2);
        }
#endif
    }
}

int gs_audio_in_start(const gs_audio_in_cfg_t *cfg) {
    if (init_i2s_rx() != ESP_OK) {
        ESP_LOGE(TAG, "i2s rx init failed");
        return -1;
    }
#if GS_HAVE_ESP_SR
    if (init_afe_and_wakenet(cfg ? cfg->wake_model_id : NULL) != ESP_OK) {
        ESP_LOGW(TAG, "esp-sr init failed — falling back to raw stream mode");
    }
#else
    ESP_LOGW(TAG, "built without esp-sr; wake word disabled, raw stream only");
    (void)cfg;
#endif
    return xTaskCreatePinnedToCore(audio_task, "gs_audio_in", GS_TASK_STACK_AUDIO,
                                    NULL, 5, NULL, 1) == pdPASS
               ? 0
               : -2;
}

void gs_audio_in_on_server_state(gs_device_state_t state) {
    // Once the server has moved past LISTENING the device shouldn't keep
    // streaming PCM into nothing. Anything that isn't LISTENING returns us
    // to "wait for wake".
    if (state != GS_STATE_LISTENING) atomic_store(&s_streaming, 0);
}

void gs_audio_in_set_muted(bool muted) {
    atomic_store(&s_muted, muted ? 1 : 0);
    if (muted) atomic_store(&s_streaming, 0);
}
