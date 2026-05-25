// TTS audio playback. Receives OGG/Opus chunks from the WS client, decodes
// to PCM, applies the software gain, ships to I2S1 → MAX98357A → speaker.
//
// Mute aborts in-flight playback; the WS client will stop feeding chunks
// independently, but we also clear any queued bytes so a mid-sentence mute
// doesn't continue once mute is released.

#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

int gs_audio_out_start(void);
void gs_audio_out_set_volume(float volume_0_1);
void gs_audio_out_set_muted(bool muted);

// Called by the WS client per TTS frame. `end` true marks 0x22 TTS_END —
// the decoder flushes and the I2S output drains.
void gs_audio_out_on_tts_chunk(const uint8_t *frame, size_t len, bool end);
