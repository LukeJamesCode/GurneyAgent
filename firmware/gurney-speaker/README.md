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
| `ws_client.c` | **Logic complete**: connect, hello, reconnect with backoff, ping echo, route inbound frames. Bench bring-up needed for the underlying `esp_websocket_client` event order. |
| `audio_in.c` | **Skeleton.** I2S0 driver init in place, ESP-SR AFE + WakeNet init in place. Wake callback wires into the WS client. Needs bench tuning of pin map + AFE config. |
| `audio_out.c` | **Skeleton.** I2S1 driver init in place, Opus decode wired through `esp_audio_codec`. Software gain stage in place. |
| `ui.c` | **Skeleton.** LVGL screens defined as state ids; minimal + orb draw funcs left as TODO. |
| `buttons.c` | **Complete.** Debounced GPIO poller, emits 0x31 BUTTON frames + applies local volume/mute. |
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

## Wake word

Default is the stock WakeNet model `wakenet9_hiesp` (hotword: "Hi ESP"). Override via NVS key `wake.model_id` or via the server's `wake_word_model` setting — the welcome frame pushes the value to the device on connect, but the change takes effect on the next reboot (WakeNet is initialised once).

A custom "Hey Gurney" model can be trained via Espressif's online service and dropped into the build; no protocol change required.

## What's intentionally out of scope (v0.1)

- SoftAP WiFi provisioning UI — credentials are flashed via NVS for v0.1.
- TLS / WSS — LAN only; per-device keys are also v2.
- OTA updates — the partition table leaves room for a second app slot but the upgrade path isn't implemented.
- Custom wake word — stock `hi_esp` ships; bring your own once you have a trained model.
