// Minimal hand-rolled JSON for the small set of payloads we exchange. Using
// a full JSON library (cJSON, jsmn) would work too — this is simpler, has
// zero allocations, and the surface is tiny enough to audit at a glance.

#include "protocol.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static const char *find_key(const char *haystack, size_t hay_len, const char *key) {
    // Look for the literal `"<key>"` substring. Not a real JSON parser — fine
    // because both sides emit canonical, single-level objects.
    size_t key_len = strlen(key);
    char needle[80];
    if (key_len + 3 >= sizeof(needle)) return NULL;
    needle[0] = '"';
    memcpy(needle + 1, key, key_len);
    needle[1 + key_len] = '"';
    needle[2 + key_len] = '\0';

    for (size_t i = 0; i + key_len + 2 <= hay_len; i++) {
        if (haystack[i] == '"' && memcmp(haystack + i + 1, key, key_len) == 0 &&
            haystack[i + 1 + key_len] == '"') {
            // Skip past the key + the colon (with optional whitespace).
            const char *p = haystack + i + 2 + key_len;
            while (p < haystack + hay_len && (*p == ' ' || *p == ':')) p++;
            return p;
        }
    }
    return NULL;
}

static bool parse_string_value(const char *p, const char *end, char *out, size_t out_len) {
    if (p >= end || *p != '"') return false;
    p++;
    size_t w = 0;
    while (p < end && *p != '"' && w + 1 < out_len) {
        if (*p == '\\' && p + 1 < end) p++; // simple escape skip
        out[w++] = *p++;
    }
    out[w] = '\0';
    return true;
}

static bool parse_bool_value(const char *p, const char *end, bool *out) {
    if (p + 4 <= end && memcmp(p, "true", 4) == 0) { *out = true; return true; }
    if (p + 5 <= end && memcmp(p, "false", 5) == 0) { *out = false; return true; }
    return false;
}

static bool parse_float_value(const char *p, const char *end, float *out) {
    char buf[32];
    size_t w = 0;
    while (p < end && w + 1 < sizeof(buf) &&
           ((*p >= '0' && *p <= '9') || *p == '.' || *p == '-' || *p == '+' || *p == 'e' || *p == 'E')) {
        buf[w++] = *p++;
    }
    if (w == 0) return false;
    buf[w] = '\0';
    *out = strtof(buf, NULL);
    return true;
}

int gs_proto_encode_empty(uint8_t op, uint8_t *out, size_t out_len) {
    if (out_len < 1) return -1;
    out[0] = op;
    return 1;
}

int gs_proto_encode_bytes(uint8_t op, const uint8_t *payload, size_t payload_len,
                          uint8_t *out, size_t out_len) {
    if (out_len < 1 + payload_len) return -1;
    out[0] = op;
    if (payload_len) memcpy(out + 1, payload, payload_len);
    return (int)(1 + payload_len);
}

int gs_proto_encode_hello(const gs_hello_t *hello, uint8_t *out, size_t out_len) {
    if (out_len < 2) return -1;
    out[0] = GS_OP_HELLO;
    int n = snprintf((char *)out + 1, out_len - 1,
                     "{\"deviceId\":\"%s\",\"secret\":\"%s\"%s%s%s}",
                     hello->device_id ? hello->device_id : "",
                     hello->secret ? hello->secret : "",
                     hello->fw_version ? ",\"fwVersion\":\"" : "",
                     hello->fw_version ? hello->fw_version : "",
                     hello->fw_version ? "\"" : "");
    if (n < 0 || (size_t)n >= out_len - 1) return -1;
    return 1 + n;
}

int gs_proto_encode_state_sync(const gs_state_sync_t *sync, uint8_t op,
                               uint8_t *out, size_t out_len) {
    if (out_len < 2) return -1;
    out[0] = op;
    char body[80];
    int w = 0;
    w += snprintf(body + w, sizeof(body) - w, "{");
    bool first = true;
    if (sync->volume_present) {
        w += snprintf(body + w, sizeof(body) - w, "%s\"volume\":%.3f",
                      first ? "" : ",", sync->volume);
        first = false;
    }
    if (sync->muted_present) {
        w += snprintf(body + w, sizeof(body) - w, "%s\"muted\":%s",
                      first ? "" : ",", sync->muted ? "true" : "false");
        first = false;
    }
    w += snprintf(body + w, sizeof(body) - w, "}");
    if (w < 0 || (size_t)w >= sizeof(body)) return -1;
    if ((size_t)w + 1 > out_len - 1) return -1;
    memcpy(out + 1, body, w);
    return 1 + w;
}

int gs_proto_encode_button(const char *button, uint8_t *out, size_t out_len) {
    if (out_len < 2) return -1;
    out[0] = GS_OP_BUTTON;
    int n = snprintf((char *)out + 1, out_len - 1, "{\"button\":\"%s\"}",
                     button ? button : "");
    if (n < 0 || (size_t)n >= out_len - 1) return -1;
    return 1 + n;
}

int gs_proto_decode_frame(const uint8_t *buf, size_t buf_len,
                          uint8_t *out_op, const uint8_t **out_payload,
                          size_t *out_payload_len) {
    if (buf_len < 1) return -1;
    *out_op = buf[0];
    *out_payload = (buf_len > 1) ? buf + 1 : buf;
    *out_payload_len = buf_len - 1;
    return 0;
}

int gs_proto_decode_welcome(const uint8_t *payload, size_t payload_len, gs_welcome_t *out) {
    const char *p = (const char *)payload;
    const char *end = p + payload_len;

    // Defaults — the server may omit any field when it isn't set.
    out->ok = false;
    out->reason[0] = '\0';
    out->display_style = GS_DISPLAY_MINIMAL;
    out->volume = 0.6f;  // matches server-side `volume_default`
    out->muted = false;
    out->voice_id[0] = '\0';

    const char *v;
    if ((v = find_key(p, payload_len, "ok"))) parse_bool_value(v, end, &out->ok);
    if ((v = find_key(p, payload_len, "reason")))
        parse_string_value(v, end, out->reason, sizeof(out->reason));
    if ((v = find_key(p, payload_len, "displayStyle"))) {
        char tmp[16];
        if (parse_string_value(v, end, tmp, sizeof(tmp)) && strcmp(tmp, "orb") == 0) {
            out->display_style = GS_DISPLAY_ORB;
        }
    }
    if ((v = find_key(p, payload_len, "volume"))) parse_float_value(v, end, &out->volume);
    if ((v = find_key(p, payload_len, "muted"))) parse_bool_value(v, end, &out->muted);
    if ((v = find_key(p, payload_len, "voiceId")))
        parse_string_value(v, end, out->voice_id, sizeof(out->voice_id));
    return 0;
}

int gs_proto_decode_state(const uint8_t *payload, size_t payload_len, gs_device_state_t *out) {
    const char *p = (const char *)payload;
    const char *v = find_key(p, payload_len, "state");
    if (!v) {
        *out = GS_STATE_UNKNOWN;
        return -1;
    }
    char tmp[20];
    if (!parse_string_value(v, p + payload_len, tmp, sizeof(tmp))) {
        *out = GS_STATE_UNKNOWN;
        return -1;
    }
    if (!strcmp(tmp, "idle"))      *out = GS_STATE_IDLE;
    else if (!strcmp(tmp, "listening")) *out = GS_STATE_LISTENING;
    else if (!strcmp(tmp, "thinking"))  *out = GS_STATE_THINKING;
    else if (!strcmp(tmp, "speaking"))  *out = GS_STATE_SPEAKING;
    else if (!strcmp(tmp, "muted"))     *out = GS_STATE_MUTED;
    else                                *out = GS_STATE_UNKNOWN;
    return 0;
}
