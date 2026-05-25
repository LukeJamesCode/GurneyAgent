// Skeleton: I2S1 driver is brought up against MAX98357A; Opus decoding hangs
// on the esp_audio_codec component (declared in idf_component.yml). The exact
// decoder init differs between releases — wire it up against the version
// you pin and validate with a known-good ogg before integrating with the
// streaming path.

#include "audio_out.h"
#include "config.h"

#include <stdatomic.h>
#include <string.h>

#include "driver/i2s_std.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"

static const char *TAG = "gs_audio_out";

static i2s_chan_handle_t s_amp_tx = NULL;
static atomic_int s_volume_q15 = 0; // volume scaled to int16, applied per sample
static atomic_int s_muted = 0;

typedef struct {
    uint8_t *data;
    size_t len;
    bool end;
} tts_msg_t;

static QueueHandle_t s_tts_q = NULL;

static esp_err_t init_i2s_tx(void) {
    i2s_chan_config_t chan_cfg = I2S_CHANNEL_DEFAULT_CONFIG(GS_AMP_I2S_PORT, I2S_ROLE_MASTER);
    esp_err_t err = i2s_new_channel(&chan_cfg, &s_amp_tx, NULL);
    if (err != ESP_OK) return err;

    i2s_std_config_t std_cfg = {
        .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(GS_AMP_SAMPLE_RATE_HZ),
        .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_16BIT,
                                                       I2S_SLOT_MODE_MONO),
        .gpio_cfg = {
            .mclk = I2S_GPIO_UNUSED,
            .bclk = GS_PIN_AMP_BCLK,
            .ws = GS_PIN_AMP_WS,
            .dout = GS_PIN_AMP_DOUT,
            .din = I2S_GPIO_UNUSED,
            .invert_flags = {0},
        },
    };
    err = i2s_channel_init_std_mode(s_amp_tx, &std_cfg);
    if (err != ESP_OK) return err;
    return i2s_channel_enable(s_amp_tx);
}

// TODO(bench): wire esp_audio_codec ogg+opus decoder here. The shape is
//   const audio_decoder_t *dec = audio_decoder_ogg_opus_new(&cfg);
//   audio_decoder_decode(dec, in_buf, in_len, out_buf, &out_len);
// We feed `dec` the bytes from each tts_msg_t and ship decoded PCM out via
// i2s_channel_write below.
static size_t decode_opus_stub(const uint8_t *in, size_t in_len, int16_t *out, size_t out_cap) {
    (void)in; (void)in_len;
    // Until the real decoder is wired in, emit silence so the audio path
    // still ticks. Useful for verifying I2S timing in isolation.
    size_t n = out_cap;
    memset(out, 0, n * sizeof(int16_t));
    return n;
}

static void apply_volume(int16_t *pcm, size_t n) {
    int gain = atomic_load(&s_volume_q15);
    for (size_t i = 0; i < n; i++) {
        int32_t v = ((int32_t)pcm[i] * gain) >> 15;
        if (v > 32767) v = 32767;
        if (v < -32768) v = -32768;
        pcm[i] = (int16_t)v;
    }
}

static void audio_out_task(void *arg) {
    (void)arg;
    int16_t pcm[1024];
    tts_msg_t msg;
    for (;;) {
        if (xQueueReceive(s_tts_q, &msg, portMAX_DELAY) != pdTRUE) continue;
        if (atomic_load(&s_muted)) {
            free(msg.data);
            continue;
        }
        if (msg.end) {
            // Drain — let the I2S DMA finish what's queued.
            i2s_channel_write(s_amp_tx, NULL, 0, NULL, 0);
            continue;
        }
        if (!msg.data || msg.len == 0) continue;

        size_t produced = decode_opus_stub(msg.data, msg.len, pcm,
                                           sizeof(pcm) / sizeof(pcm[0]));
        free(msg.data);
        apply_volume(pcm, produced);
        size_t written = 0;
        i2s_channel_write(s_amp_tx, pcm, produced * sizeof(int16_t), &written, portMAX_DELAY);
    }
}

int gs_audio_out_start(void) {
    if (init_i2s_tx() != ESP_OK) {
        ESP_LOGE(TAG, "i2s tx init failed");
        return -1;
    }
    gs_audio_out_set_volume(GS_DEFAULT_VOLUME);
    s_tts_q = xQueueCreate(64, sizeof(tts_msg_t));
    if (!s_tts_q) return -2;
    return xTaskCreatePinnedToCore(audio_out_task, "gs_audio_out", GS_TASK_STACK_AUDIO,
                                    NULL, 5, NULL, 0) == pdPASS
               ? 0
               : -3;
}

void gs_audio_out_set_volume(float v) {
    if (v < 0) v = 0;
    if (v > 1) v = 1;
    atomic_store(&s_volume_q15, (int)(v * 32768.0f));
}

void gs_audio_out_set_muted(bool muted) {
    atomic_store(&s_muted, muted ? 1 : 0);
    // Drain queued chunks — letting them play after un-mute would echo a
    // stale sentence.
    if (muted) {
        tts_msg_t m;
        while (s_tts_q && xQueueReceive(s_tts_q, &m, 0) == pdTRUE) free(m.data);
    }
}

void gs_audio_out_on_tts_chunk(const uint8_t *frame, size_t len, bool end) {
    if (!s_tts_q) return;
    tts_msg_t msg = { .data = NULL, .len = 0, .end = end };
    if (!end && frame && len) {
        msg.data = malloc(len);
        if (!msg.data) return;
        memcpy(msg.data, frame, len);
        msg.len = len;
    }
    if (xQueueSend(s_tts_q, &msg, pdMS_TO_TICKS(50)) != pdTRUE) {
        if (msg.data) free(msg.data);
    }
}
