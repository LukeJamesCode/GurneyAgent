// Wire protocol — mirror of extensions/gurney-speaker/protocol.ts.
//
// One binary WS message = one frame. Byte 0 is the opcode; bytes 1.. are the
// payload. JSON payloads are UTF-8; audio payloads are raw bytes. Keep this
// file in lockstep with the server's protocol.ts — any drift is a corrupt
// wire contract that the unit tests on either side can't catch.

#pragma once

#include <stddef.h>
#include <stdint.h>
#include <stdbool.h>

// Client → server
#define GS_OP_HELLO         0x01
#define GS_OP_WAKE          0x10
#define GS_OP_PCM_FRAME     0x11
#define GS_OP_UTTERANCE_END 0x12
#define GS_OP_STATE_SYNC_C  0x30
#define GS_OP_BUTTON        0x31

// Server → client
#define GS_OP_WELCOME       0x02
#define GS_OP_STATE         0x20
#define GS_OP_TTS_FRAME     0x21
#define GS_OP_TTS_END       0x22
#define GS_OP_STATE_SYNC_S  0x30

// Both
#define GS_OP_PING          0x7f

// Device-side mirror of the server's DeviceState enum. Pushed to us via
// 0x20 STATE frames — we use it to drive the LCD.
typedef enum {
    GS_STATE_IDLE = 0,
    GS_STATE_LISTENING,
    GS_STATE_THINKING,
    GS_STATE_SPEAKING,
    GS_STATE_MUTED,
    GS_STATE_UNKNOWN,
} gs_device_state_t;

// Display style flag pushed in the welcome frame. Drives which set of LVGL
// draw funcs the UI task uses.
typedef enum {
    GS_DISPLAY_MINIMAL = 0,
    GS_DISPLAY_ORB,
} gs_display_style_t;

// Parsed welcome frame (op 0x02). Fields not present in the JSON are left at
// their initialised defaults.
typedef struct {
    bool ok;
    char reason[32];
    gs_display_style_t display_style;
    float volume;
    bool muted;
    char voice_id[64];
} gs_welcome_t;

// Outbound hello frame (op 0x01). Caller fills in deviceId + secret +
// optional firmware version; gs_proto_encode_hello() serialises it.
typedef struct {
    const char *device_id;
    const char *secret;
    const char *fw_version;  // may be NULL
} gs_hello_t;

// Volume / mute state change (both directions, op 0x30). Use the *_present
// flags to mark which fields the sender actually set — a 0 volume isn't the
// same as "no opinion".
typedef struct {
    bool volume_present;
    float volume;
    bool muted_present;
    bool muted;
} gs_state_sync_t;

// Encoded frame is written into `out` (which must be at least 1 + payload
// bytes). Returns the number of bytes written, or -1 on overflow.
int gs_proto_encode_empty(uint8_t op, uint8_t *out, size_t out_len);
int gs_proto_encode_bytes(uint8_t op, const uint8_t *payload, size_t payload_len,
                          uint8_t *out, size_t out_len);

// JSON-payload encoders. The encoders allocate via the caller-supplied buffer
// — no malloc. Returns the number of bytes written, or -1 if the buffer is
// too small.
int gs_proto_encode_hello(const gs_hello_t *hello, uint8_t *out, size_t out_len);
int gs_proto_encode_state_sync(const gs_state_sync_t *sync, uint8_t op,
                               uint8_t *out, size_t out_len);
int gs_proto_encode_button(const char *button, uint8_t *out, size_t out_len);

// Decode the opcode + payload pointer/length from a received frame. The
// payload pointer aliases into the input buffer; do not free it separately.
// Returns 0 on success, -1 if the frame is empty.
int gs_proto_decode_frame(const uint8_t *buf, size_t buf_len,
                          uint8_t *out_op,
                          const uint8_t **out_payload,
                          size_t *out_payload_len);

// Parse a welcome JSON payload. Forgiving — missing fields leave `out` at
// the values it was initialised with. Returns 0 on success.
int gs_proto_decode_welcome(const uint8_t *payload, size_t payload_len, gs_welcome_t *out);

// Parse a state JSON payload of the form {"state":"..."} into the enum.
// Unknown states map to GS_STATE_UNKNOWN. Returns 0 on success.
int gs_proto_decode_state(const uint8_t *payload, size_t payload_len, gs_device_state_t *out);
