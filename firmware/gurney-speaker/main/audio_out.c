// Inbound TTS playback: the server ships OGG/Opus chunks on opcode 0x21,
// ws_client hands each one to gs_audio_out_on_tts_chunk(), and this task
// decodes them through esp_audio_codec's simple decoder and writes int16 PCM
// out through I2S1 to the MAX98357A.
//
// The decoder is opened once at start and reset between utterances. Opening
// per-turn would reallocate Opus's working buffers (~30 KB) each time —
// pointless given the device only ever plays one stream at once. We feed
// raw bytes in chunks; the OGG parser handles arbitrary slice points because
// the server-side WS layer cuts the OGG bitstream at 4 KB boundaries with no
// regard for page edges.
//
// Sample rate is locked to 48 kHz mono int16 — that's what ffmpeg emits on
// the server side. If anyone ever changes the server's `-ar` flag the I2S
// rate in config.h has to follow. The decoder reports its own rate via
// esp_audio_simple_dec_get_info(); we log a warning if it disagrees with
// what I2S is configured for rather than trying to reconfigure live.

#include "audio_out.h"
#include "config.h"

#include <stdatomic.h>
#include <string.h>

#include "driver/i2s_std.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"

#include "esp_audio_dec_default.h"
#include "esp_audio_simple_dec.h"
#include "esp_audio_simple_dec_default.h"

static const char *TAG = "gs_audio_out";

static i2s_chan_handle_t s_amp_tx = NULL;
static atomic_int s_volume_q15 = 0; // volume scaled to int16, applied per sample
static atomic_int s_muted = 0;

static esp_audio_simple_dec_handle_t s_dec = NULL;
static bool s_info_logged = false;

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

static esp_err_t init_decoder(void) {
    esp_audio_err_t err = esp_audio_dec_register_default();
    if (err != ESP_AUDIO_ERR_OK) {
        ESP_LOGE(TAG, "esp_audio_dec_register_default failed: %d", err);
        return ESP_FAIL;
    }
    err = esp_audio_simple_dec_register_default();
    if (err != ESP_AUDIO_ERR_OK) {
        ESP_LOGE(TAG, "esp_audio_simple_dec_register_default failed: %d", err);
        return ESP_FAIL;
    }
    esp_audio_simple_dec_cfg_t cfg = {
        .dec_type = ESP_AUDIO_SIMPLE_DEC_TYPE_OGG,
        .dec_cfg = NULL,
        .cfg_size = 0,
        .use_frame_dec = false,
    };
    err = esp_audio_simple_dec_open(&cfg, &s_dec);
    if (err != ESP_AUDIO_ERR_OK || !s_dec) {
        ESP_LOGE(TAG, "esp_audio_simple_dec_open failed: %d", err);
        return ESP_FAIL;
    }
    return ESP_OK;
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

static void log_info_once(void) {
    if (s_info_logged || !s_dec) return;
    esp_audio_simple_dec_info_t info = {0};
    if (esp_audio_simple_dec_get_info(s_dec, &info) == ESP_AUDIO_ERR_OK && info.sample_rate) {
        ESP_LOGI(TAG, "decoder reports %lu Hz, %u ch, %u bits",
                 (unsigned long)info.sample_rate, info.channel, info.bits_per_sample);
        if (info.sample_rate != GS_AMP_SAMPLE_RATE_HZ) {
            ESP_LOGW(TAG, "sample rate mismatch: I2S=%d but stream=%lu — pitch will be wrong",
                     GS_AMP_SAMPLE_RATE_HZ, (unsigned long)info.sample_rate);
        }
        s_info_logged = true;
    }
}

static void write_pcm(const uint8_t *pcm, size_t bytes) {
    if (!bytes) return;
    apply_volume((int16_t *)pcm, bytes / sizeof(int16_t));
    size_t written = 0;
    i2s_channel_write(s_amp_tx, pcm, bytes, &written, portMAX_DELAY);
}

static void decode_and_write(uint8_t *in, size_t in_len, bool eos) {
    if (!s_dec) return;
    // Stack frame for the audio task is GS_TASK_STACK_AUDIO (8 KB); a 4 KB
    // PCM buffer here would eat half the stack. Keep it static — the task is
    // single-threaded for output so there's no re-entrancy concern.
    static uint8_t pcm_out[4096];
    esp_audio_simple_dec_raw_t raw = {
        .buffer = in,
        .len = in_len,
        .eos = eos,
        .consumed = 0,
    };
    // One inbound chunk can contain multiple Opus packets; loop until the
    // decoder has consumed everything we gave it (or signals it needs more).
    for (;;) {
        esp_audio_simple_dec_out_t out = {
            .buffer = pcm_out,
            .len = sizeof(pcm_out),
        };
        esp_audio_err_t err = esp_audio_simple_dec_process(s_dec, &raw, &out);
        if (err == ESP_AUDIO_ERR_OK) {
            write_pcm(pcm_out, out.decoded_size);
            log_info_once();
        } else if (err == ESP_AUDIO_ERR_BUFF_NOT_ENOUGH) {
            // Static buffer is sized for a worst-case frame; if we hit this,
            // the stream is producing something we didn't expect. Drop and
            // keep going so a bad packet doesn't stall the queue.
            ESP_LOGW(TAG, "decoder wants %lu byte out buf, dropping frame",
                     (unsigned long)out.needed_size);
        } else {
            ESP_LOGW(TAG, "decoder err %d, dropping chunk", err);
            return;
        }
        if (raw.consumed == 0 && out.decoded_size == 0) {
            // Decoder didn't advance — either it needs more input bytes (we'll
            // pick them up on the next chunk) or it produced silence. Stop.
            return;
        }
        if (raw.consumed >= raw.len) return;
        raw.buffer  += raw.consumed;
        raw.len     -= raw.consumed;
        raw.consumed = 0;
    }
}

static void audio_out_task(void *arg) {
    (void)arg;
    tts_msg_t msg;
    for (;;) {
        if (xQueueReceive(s_tts_q, &msg, portMAX_DELAY) != pdTRUE) continue;
        if (atomic_load(&s_muted)) {
            if (msg.data) free(msg.data);
            continue;
        }
        if (msg.end) {
            // Flush any decoder-cached audio then reset for the next utterance.
            decode_and_write(NULL, 0, true);
            esp_audio_simple_dec_reset(s_dec);
            s_info_logged = false;
            continue;
        }
        if (!msg.data || msg.len == 0) continue;
        decode_and_write(msg.data, msg.len, false);
        free(msg.data);
    }
}

int gs_audio_out_start(void) {
    if (init_i2s_tx() != ESP_OK) {
        ESP_LOGE(TAG, "i2s tx init failed");
        return -1;
    }
    if (init_decoder() != ESP_OK) {
        ESP_LOGE(TAG, "decoder init failed");
        return -2;
    }
    gs_audio_out_set_volume(GS_DEFAULT_VOLUME);
    s_tts_q = xQueueCreate(64, sizeof(tts_msg_t));
    if (!s_tts_q) return -3;
    return xTaskCreatePinnedToCore(audio_out_task, "gs_audio_out", GS_TASK_STACK_AUDIO,
                                    NULL, 5, NULL, 0) == pdPASS
               ? 0
               : -4;
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
        if (s_dec) {
            esp_audio_simple_dec_reset(s_dec);
            s_info_logged = false;
        }
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
