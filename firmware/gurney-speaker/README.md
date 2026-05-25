# gurney-speaker firmware

ESP-IDF firmware for the Gurney puck — a small handmade smart speaker that talks to the [`gurney-speaker`](../../extensions/gurney-speaker) server extension.

## Hardware target

- ESP32-S3 dev board (≥ 4 MB flash, PSRAM strongly recommended for ESP-SR + LVGL)
- 2× I2S omni mics (e.g. INMP441 / ICS-43434) on I2S0
- MAX98357A 3 W class-D amp on I2S1 driving the Echo Dot speaker
- 1.28" round GC9A01 240×240 LCD over SPI
- 4 momentary buttons: volume +, volume −, mute, spare

The exact pin assignments live in `main/config.h`. They are placeholders — verify against the schematic before flashing.

## Status — what's actually working

| Module | State |
|--------|-------|
| `protocol.c` | **Complete + matches server byte-for-byte.** Opcodes, frame helpers, hello/welcome/state JSON shape. |
| `ws_client.c` | **Complete.** Connect, hello, reconnect with backoff, ping echo, route inbound frames. The PING echo is mutex-free now (stack-local 1-byte buffer) so it can't deadlock against an in-flight PCM send. |
| `audio_in.c` | **Working with PTT, WakeNet still optional.** I2S0 driver init + ESP-SR AFE + WakeNet init in place. `gs_audio_in_set_ptt(true/false)` lets the spare button drive a "hold to talk" loop without a flashed WakeNet model. |
| `audio_out.c` | **Skeleton.** I2S1 driver init in place; Opus decode is the stubbed `decode_opus_stub()` that emits silence. Wire `esp_audio_codec` here to make replies audible. |
| `ui.c` | **Skeleton.** State + style transitions logged; LVGL screens left as TODO. Backlight comes on but the panel stays black. |
| `buttons.c` | **Complete + PTT.** Debounced GPIO poller, emits 0x31 BUTTON frames, applies local volume/mute, and drives the PTT pipeline on the spare button (press → WAKE; release → UTTERANCE_END). |
| `nvs_store.c` | **Complete.** Device id, secret, WiFi creds, last volume from NVS. |

Anything tagged **Skeleton** compiles and the public API is stable enough for the surrounding code to call it — the runtime behaviour needs an oscilloscope (or at least serial logs from real hardware) to validate.

## Build & flash

See [`GETTING_STARTED.md`](GETTING_STARTED.md) for the full guide (wiring, server-side setup, provisioning, smoke tests, troubleshooting). Quick version once everything's set up:

```bash
. $IDF_PATH/export.sh
idf.py set-target esp32s3
idf.py build
python tools/provision.py --device-id puck-1 --secret ... --server-url ws://.../  --wifi-ssid ... --wifi-psk ... --output nvs.bin
idf.py -p /dev/ttyUSB0 flash
parttool.py -p /dev/ttyUSB0 write_partition --partition-name nvs --input nvs.bin
idf.py -p /dev/ttyUSB0 monitor
```

## Wake word + PTT

Default is the stock WakeNet model `wakenet9_hiesp` (hotword: "Hi ESP"). Override via NVS key `wake.model_id` or via the server's `wake_word_model` setting — the welcome frame pushes the value to the device on connect, but the change takes effect on the next reboot (WakeNet is initialised once).

A custom "Hey Gurney" model can be trained via Espressif's online service and dropped into the build; no protocol change required.

**Without** a WakeNet model flashed, the device falls back to a push-to-talk loop on the spare button (GPIO 39 by default). Hold it to stream PCM to the server; let go to close the turn. The wire protocol doesn't change — `gs_ws_send_wake()` + `gs_ws_send_utterance_end()` are the same frames WakeNet would emit.

## What's intentionally out of scope (v0.1)

- SoftAP WiFi provisioning UI — credentials are flashed via NVS for v0.1.
- TLS / WSS — LAN only; per-device keys are also v2.
- OTA updates — the partition table leaves room for a second app slot but the upgrade path isn't implemented.
- Custom wake word — stock `hi_esp` ships; bring your own once you have a trained model.
