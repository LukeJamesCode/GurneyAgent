// Microphone capture + wake-word + utterance streaming.
//
// On boot: I2S0 is configured for the two mics; ESP-SR's AFE is wrapped
// around the I2S read loop to give us AEC + AGC + NS; WakeNet runs on the
// AFE output. When the hotword fires we transition to STREAMING, where each
// 20 ms 16 kHz mono PCM frame is pushed to the WS client until the server
// closes the turn (via a 0x20 STATE thinking/idle).

#pragma once

#include <stdbool.h>

#include "protocol.h"

typedef struct {
    const char *wake_model_id;  // e.g. "wakenet9_hiesp"
} gs_audio_in_cfg_t;

int gs_audio_in_start(const gs_audio_in_cfg_t *cfg);

// Called by the UI dispatcher when STATE frames arrive — keeps audio_in in
// step with what the server thinks. We use this to switch back from
// STREAMING to IDLE once the server has finished a turn.
void gs_audio_in_on_server_state(gs_device_state_t state);

// Hard stop: the mute button was pressed. Drains buffers, halts I2S reads.
void gs_audio_in_set_muted(bool muted);

// Push-to-talk override. While `held` is true the audio task streams PCM
// frames to the server regardless of WakeNet state. On the rising edge of
// `held` (false → true) we also synthesise a WAKE event so the server moves
// into LISTENING. On the falling edge (true → false) we send UTTERANCE_END
// so the turn closes immediately rather than waiting for the silence VAD.
//
// PTT is the documented escape hatch when no WakeNet model is flashed —
// without it the device has no way to initiate a turn over voice. Bound to
// the "spare" hardware button.
void gs_audio_in_set_ptt(bool held);
