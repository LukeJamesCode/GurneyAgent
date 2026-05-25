// WebSocket adapter for the Gurney server. Owns the connection, the hello
// handshake, reconnect-with-backoff, and the inbound frame dispatch.
//
// Outbound is fire-and-forget: gs_ws_send_pcm / gs_ws_send_button enqueue
// frames; if the socket is closed they're dropped (PCM at this rate is fine
// to lose for a few seconds during reconnect; the audio task should pause
// its WAKE → LISTENING transition until gs_ws_is_connected() is true).

#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "protocol.h"

typedef void (*gs_ws_state_cb_t)(gs_device_state_t state);
typedef void (*gs_ws_tts_cb_t)(const uint8_t *frame, size_t len, bool end);
typedef void (*gs_ws_welcome_cb_t)(const gs_welcome_t *welcome);

typedef struct {
    const char *server_url;       // e.g. ws://192.168.1.42:7820/
    const char *device_id;
    const char *secret;
    const char *fw_version;       // may be NULL

    gs_ws_welcome_cb_t on_welcome;
    gs_ws_state_cb_t on_state;
    gs_ws_tts_cb_t on_tts_chunk;  // called per TTS frame; `end` true marks TTS_END
} gs_ws_config_t;

// Start the client task. Returns ESP_OK on success, error on bad config or
// task spawn failure.
int gs_ws_start(const gs_ws_config_t *cfg);

// True after the hello → welcome handshake completes.
bool gs_ws_is_connected(void);

// Enqueue outbound frames. Safe to call from any task. Returns 0 on success,
// negative on overflow / closed-socket drop.
int gs_ws_send_wake(void);
int gs_ws_send_pcm(const uint8_t *pcm, size_t len);
int gs_ws_send_utterance_end(void);
int gs_ws_send_button(const char *button);
int gs_ws_send_state_sync(float volume, bool has_volume, bool muted, bool has_muted);
