// esp_websocket_client wrapper. The library handles the low-level wire,
// reconnect, and event loop — we just wire the events into our protocol
// helpers and call out to the user-supplied callbacks.

#include "ws_client.h"
#include "config.h"

#include <string.h>

#include "esp_log.h"
#include "esp_websocket_client.h"
#include "esp_event.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

static const char *TAG = "gs_ws";

static esp_websocket_client_handle_t s_client = NULL;
static gs_ws_config_t s_cfg = {0};
static bool s_handshake_done = false;
static SemaphoreHandle_t s_tx_lock = NULL;

// Scratch buffer for outbound encoded frames. PCM is by far the largest at
// 1 + 640 bytes per 20 ms frame; round up to GS_MAX_WS_FRAME_BYTES.
static uint8_t s_tx_buf[GS_MAX_WS_FRAME_BYTES];

static void send_hello(void) {
    gs_hello_t hello = {
        .device_id = s_cfg.device_id,
        .secret = s_cfg.secret,
        .fw_version = s_cfg.fw_version,
    };
    int n = gs_proto_encode_hello(&hello, s_tx_buf, sizeof(s_tx_buf));
    if (n < 0) {
        ESP_LOGE(TAG, "hello encode failed");
        return;
    }
    esp_websocket_client_send_bin(s_client, (const char *)s_tx_buf, n, portMAX_DELAY);
    ESP_LOGI(TAG, "hello sent (deviceId=%s)", s_cfg.device_id);
}

static void handle_inbound(const uint8_t *data, size_t len) {
    uint8_t op = 0;
    const uint8_t *payload = NULL;
    size_t payload_len = 0;
    if (gs_proto_decode_frame(data, len, &op, &payload, &payload_len) != 0) {
        ESP_LOGW(TAG, "decode failed (len=%u)", (unsigned)len);
        return;
    }

    switch (op) {
        case GS_OP_WELCOME: {
            gs_welcome_t w;
            gs_proto_decode_welcome(payload, payload_len, &w);
            if (!w.ok) {
                ESP_LOGE(TAG, "welcome rejected (reason=%s) — check device_shared_secret",
                         w.reason[0] ? w.reason : "unknown");
                // Let esp_websocket_client retry; this is mostly informational.
                return;
            }
            s_handshake_done = true;
            ESP_LOGI(TAG, "welcome ok (display=%d, vol=%.2f, muted=%d)",
                     (int)w.display_style, w.volume, (int)w.muted);
            if (s_cfg.on_welcome) s_cfg.on_welcome(&w);
            break;
        }
        case GS_OP_STATE: {
            gs_device_state_t st = GS_STATE_UNKNOWN;
            gs_proto_decode_state(payload, payload_len, &st);
            if (s_cfg.on_state) s_cfg.on_state(st);
            break;
        }
        case GS_OP_TTS_FRAME:
            if (s_cfg.on_tts_chunk) s_cfg.on_tts_chunk(payload, payload_len, false);
            break;
        case GS_OP_TTS_END:
            if (s_cfg.on_tts_chunk) s_cfg.on_tts_chunk(NULL, 0, true);
            break;
        case GS_OP_PING:
            // Echo: server probes liveness, we ack with the same opcode.
            s_tx_buf[0] = GS_OP_PING;
            esp_websocket_client_send_bin(s_client, (const char *)s_tx_buf, 1, 0);
            break;
        default:
            ESP_LOGW(TAG, "unknown opcode 0x%02x (len=%u)", op, (unsigned)payload_len);
    }
}

static void ws_event_handler(void *arg, esp_event_base_t base, int32_t event_id, void *event_data) {
    (void)arg; (void)base;
    const esp_websocket_event_data_t *data = (const esp_websocket_event_data_t *)event_data;
    switch (event_id) {
        case WEBSOCKET_EVENT_CONNECTED:
            ESP_LOGI(TAG, "connected, sending hello");
            s_handshake_done = false;
            send_hello();
            break;
        case WEBSOCKET_EVENT_DISCONNECTED:
            ESP_LOGW(TAG, "disconnected");
            s_handshake_done = false;
            break;
        case WEBSOCKET_EVENT_DATA:
            if (data->op_code == 0x02 /* binary */) {
                handle_inbound((const uint8_t *)data->data_ptr, data->data_len);
            }
            break;
        case WEBSOCKET_EVENT_ERROR:
            ESP_LOGW(TAG, "transport error");
            break;
        default:
            break;
    }
}

int gs_ws_start(const gs_ws_config_t *cfg) {
    if (!cfg || !cfg->server_url || !cfg->device_id || !cfg->secret) return -1;
    s_cfg = *cfg;
    s_tx_lock = xSemaphoreCreateMutex();
    if (!s_tx_lock) return -2;

    esp_websocket_client_config_t ws_cfg = {
        .uri = cfg->server_url,
        .reconnect_timeout_ms = 5000,
        .network_timeout_ms = 10000,
        .ping_interval_sec = 20,
        .disable_pingpong_discon = false,
    };
    s_client = esp_websocket_client_init(&ws_cfg);
    if (!s_client) return -3;
    esp_websocket_register_events(s_client, WEBSOCKET_EVENT_ANY, ws_event_handler, NULL);
    esp_websocket_client_start(s_client);
    return 0;
}

bool gs_ws_is_connected(void) {
    return s_client && esp_websocket_client_is_connected(s_client) && s_handshake_done;
}

// Common send wrapper. Drops the frame if the socket isn't ready — saves us
// from blocking the audio task during reconnects.
static int send_locked(const uint8_t *buf, int len) {
    if (len < 0) return -1;
    if (!gs_ws_is_connected()) return -2;
    if (xSemaphoreTake(s_tx_lock, pdMS_TO_TICKS(10)) != pdTRUE) return -3;
    int written = esp_websocket_client_send_bin(s_client, (const char *)buf, len, pdMS_TO_TICKS(50));
    xSemaphoreGive(s_tx_lock);
    return (written == len) ? 0 : -4;
}

int gs_ws_send_wake(void) {
    uint8_t buf[1];
    int n = gs_proto_encode_empty(GS_OP_WAKE, buf, sizeof(buf));
    return send_locked(buf, n);
}

int gs_ws_send_pcm(const uint8_t *pcm, size_t len) {
    if (len + 1 > sizeof(s_tx_buf)) return -1;
    if (xSemaphoreTake(s_tx_lock, pdMS_TO_TICKS(10)) != pdTRUE) return -3;
    int n = gs_proto_encode_bytes(GS_OP_PCM_FRAME, pcm, len, s_tx_buf, sizeof(s_tx_buf));
    int written = (n > 0 && gs_ws_is_connected())
        ? esp_websocket_client_send_bin(s_client, (const char *)s_tx_buf, n, pdMS_TO_TICKS(50))
        : -1;
    xSemaphoreGive(s_tx_lock);
    return (written == n) ? 0 : -2;
}

int gs_ws_send_utterance_end(void) {
    uint8_t buf[1];
    int n = gs_proto_encode_empty(GS_OP_UTTERANCE_END, buf, sizeof(buf));
    return send_locked(buf, n);
}

int gs_ws_send_button(const char *button) {
    uint8_t buf[64];
    int n = gs_proto_encode_button(button, buf, sizeof(buf));
    return send_locked(buf, n);
}

int gs_ws_send_state_sync(float volume, bool has_volume, bool muted, bool has_muted) {
    gs_state_sync_t sync = {
        .volume_present = has_volume,
        .volume = volume,
        .muted_present = has_muted,
        .muted = muted,
    };
    uint8_t buf[80];
    int n = gs_proto_encode_state_sync(&sync, GS_OP_STATE_SYNC_C, buf, sizeof(buf));
    return send_locked(buf, n);
}
