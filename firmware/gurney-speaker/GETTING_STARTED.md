# Getting started — Gurney puck v0.1

End-to-end guide: from bare ESP32-S3 + parts on the bench to saying "Hi ESP, what time is it?" and hearing Gurney reply through the Echo Dot speaker.

> **Reality check.** The firmware in this repo is a working skeleton — the wire protocol, WS client, button handling, and boot sequence are tested logic that mirrors the server side. A few pieces (GC9A01 panel driver, Opus decoder integration, INMP441 bit alignment) are wired with the right ESP-IDF APIs but need bench bring-up before they'll do what you want. Each bench-only step is flagged in the guide.

---

## 0. What you need

**Hardware**
- ESP32-S3 dev board (4 MB+ flash; PSRAM strongly recommended for LVGL + esp-sr)
- 2× I2S omnidirectional mics (INMP441 or ICS-43434)
- MAX98357A 3 W class-D amp
- Speaker (the one pulled from the Echo Dot gen 3 is fine)
- 1.28" round GC9A01 240×240 SPI LCD
- 4× momentary push buttons + pull-up resistors (or use the chip's internal pull-ups)
- USB cable for flashing
- Jumper wires + perfboard or breadboard

**Software** (server box — Pi 5, mini-PC, whatever you're running Gurney on)
- A working Gurney install with `gurney-voice` set up (whisper + Piper models downloaded). This is mandatory — `gurney-speaker` piggybacks on those engines.
- Python 3.10+ for the provisioning helper.

**Software** (your dev machine, where you build the firmware)
- ESP-IDF v5.1 or newer. Install via the [official installer](https://docs.espressif.com/projects/esp-idf/en/v5.1/esp32s3/get-started/index.html) or the VS Code extension.
- Drivers for the USB-to-serial bridge on your dev board (CP210x or CH340 — check your board).

---

## 1. Wire the hardware

Pin assignments live in [`main/config.h`](main/config.h). They were picked to avoid the S3's strapping pins (0, 3, 45, 46) and USB pins (19, 20) but **verify them against your dev board's silkscreen before you solder anything** — every "ESP32-S3 dev board" lays out pins slightly differently.

| Function | ESP32-S3 GPIO | Connect to |
|---|---|---|
| Mic BCLK | 4 | Both mics' BCLK |
| Mic WS / LR | 5 | Both mics' WS |
| Mic DIN | 6 | Mics' SD (one to L, one to R, via the L/R pin selector on each board) |
| Mic 3V3 + GND | 3V3, GND | Power both mics |
| Amp BCLK | 7 | MAX98357A BCLK |
| Amp WS / LR | 8 | MAX98357A LRC |
| Amp DOUT | 9 | MAX98357A DIN |
| Amp VIN (5V) + GND | 5V, GND | MAX98357A VIN / GND (5V gets you more output; 3V3 works too) |
| LCD SCK | 12 | GC9A01 SCL |
| LCD MOSI | 11 | GC9A01 SDA |
| LCD DC | 10 | GC9A01 DC |
| LCD CS | 13 | GC9A01 CS |
| LCD RST | 14 | GC9A01 RST |
| LCD 3V3 + GND | 3V3, GND | Panel power. BL is hardwired on this LCD breakout — no GPIO needed |
| Button: vol_up | 15 | One side to GPIO, other to GND |
| Button: vol_down | 16 | " |
| Button: mute | 17 | " |
| Button: spare | 39 | " (wired but ignored in v0.1) |
| Speaker | — | MAX98357A + and − to the speaker terminals |

Internal pull-ups are enabled for the buttons in firmware — you don't need external pull-up resistors on the button GPIOs.

---

## 2. Set up the server side

On the box where Gurney runs:

1. **Install the extension.**
   ```bash
   gurney ext install gurney-speaker
   ```
   This pulls the extension into `~/.gurney/extensions/gurney-speaker/`, runs the included migration, and calls `setup.ts` which generates a fresh `device_shared_secret`. Copy the printed secret somewhere — you'll need it for provisioning.

2. **Point the extension at gurney-voice's engines.** Open `~/.gurney/config` (or use `gurney config gurney-speaker <key> <value>`):
   ```bash
   gurney config gurney-speaker whisper_model_path ~/.gurney/extension_state/gurney-voice/whisper-models/ggml-base.en.bin
   gurney config gurney-speaker voice_model_path  ~/.gurney/extension_state/gurney-voice/voices/en_GB-northern_english_male-medium.onnx
   ```
   (Adjust the paths if you picked different models when setting up gurney-voice.)

3. **Pick which conversation the device posts into.** This shares memory and history with your Telegram chat:
   ```bash
   gurney config gurney-speaker owner_chat_id <your-telegram-chat-id>
   ```

4. **Restart Gurney.** The new `jobs.ts` entrypoint binds the WebSocket server on `0.0.0.0:7820`.
   ```bash
   gurney restart
   journalctl -u gurney -n 50 -f   # or your equivalent log tail
   ```
   You should see:
   ```
   gurney-speaker ws server listening { host: '0.0.0.0', port: 7820 }
   ```

5. **Open port 7820 on your LAN firewall** if you have one. The device connects over plain WS — no TLS in v0.1.

---

## 3. Build the firmware

On your dev machine:

```bash
cd firmware/gurney-speaker

# One-time per shell session
. $IDF_PATH/export.sh

# One-time per checkout
idf.py set-target esp32s3

# Build
idf.py build
```

First build pulls in the IDF component manager deps (esp-sr, esp_websocket_client, lvgl, esp_audio_codec) — expect 5–15 minutes the first time, fast incremental builds after that.

**If the build fails on esp-sr,** check that PSRAM is enabled (it is in `sdkconfig.defaults`) and that you're on IDF ≥ 5.1.

---

## 4. Provision the device (one-time per device)

The firmware reads its WiFi credentials, server URL, device id, and shared secret from NVS — not hardcoded, not over a setup UI. You build a 24 KB NVS partition image once and flash it alongside the app.

```bash
# Still in firmware/gurney-speaker/
python tools/provision.py \
    --device-id puck-living-room \
    --secret "PASTE-THE-device_shared_secret-HERE" \
    --server-url ws://192.168.1.42:7820/ \
    --wifi-ssid YourWiFi \
    --wifi-psk YourWiFiPassword \
    --output nvs.bin
```

Replace `192.168.1.42` with the LAN IP of your Gurney box. Use `ip a` / `ifconfig` to find it.

The script writes `nvs.bin` next to itself. Keep this file out of git — it has your WiFi password.

---

## 5. Flash everything

Plug the board in, find its serial port:

- **Linux:** `/dev/ttyUSB0` or `/dev/ttyACM0`
- **macOS:** `/dev/cu.usbserial-*` or `/dev/cu.usbmodem*`
- **Windows:** `COM3`, `COM4`, … (check Device Manager)

```bash
# Flash the app + partition table + bootloader
idf.py -p /dev/ttyUSB0 flash

# Flash the NVS image into the nvs partition
parttool.py -p /dev/ttyUSB0 write_partition --partition-name nvs --input nvs.bin

# Watch it boot
idf.py -p /dev/ttyUSB0 monitor
```

`parttool.py` ships with ESP-IDF — it should be on your PATH after `export.sh`.

Exit the monitor with `Ctrl+]`.

---

## 6. What a healthy first boot looks like

Watching the serial monitor, you should see roughly:

```
I (300)  gs_main: gurney-speaker firmware v0.1.0 booting
I (340)  gs_main: got ip
I (350)  gs_ui:   state -> 0
I (420)  gs_ws:   connected, sending hello
I (430)  gs_ws:   hello sent (deviceId=puck-living-room)
I (480)  gs_ws:   welcome ok (display=0, vol=0.60, muted=0)
I (490)  gs_main: server welcome: display=0, voice=en_GB-northern_english_male-medium
I (500)  gs_main: boot complete
```

Meanwhile on the server (`journalctl -fu gurney`):
```
gurney-speaker/ws  device connected  { deviceId: 'puck-living-room', fwVersion: '0.1.0' }
```

If you only see "connected, sending hello" with no welcome, the secret doesn't match. Re-check the value you passed to `--secret` matches what's in `gurney config gurney-speaker device_shared_secret`.

---

## 7. Smoke tests — go in this order

These let you validate each subsystem independently before you try the full voice round-trip.

### 7a. Buttons + state-sync (no audio needed)

Press each button. Server log should show:
```
device button { button: 'vol_up' }
device button { button: 'mute' }
```
Mute should toggle the local state immediately (the firmware applies mute locally without waiting for the server). Press it again to unmute.

### 7b. Display screens

The LCD should show "idle" in grey on boot. **If the panel stays black:** the GC9A01 driver init in `ui.c` is still a `TODO(bench)` — see the [bench bring-up](#bench-bring-up-todos) section below. Everything else still works without the display.

### 7c. Outbound PCM stream

Easiest way to validate the mic + WS path: comment out the WakeNet gate temporarily in `audio_in.c` so the device streams continuously, then watch `pcmBytes` climb in the server's session log:
```
speaker turn closed { reason: 'silence', pcmBytes: 64000 }
```

Restore the WakeNet gate once you've confirmed the bytes flow.

### 7d. Wake word → transcript

With WakeNet enabled, say **"Hi ESP"** clearly toward the mics. Serial monitor should print:
```
I gs_audio_in: wake detected
```
And on the server:
```
speaker turn closed { reason: 'silence', pcmBytes: <some number> }
```
followed by a transcript line if the whisper model can pick it up.

### 7e. End-to-end with TTS

> **Heads up:** TTS playback requires the Opus decoder integration in `audio_out.c`, which is currently stubbed to silence. Until you wire it (see [bench bring-up](#bench-bring-up-todos)), the device transcribes and dispatches your query but the reply comes back as silence — you'll see the state cycle to `speaking` on the LCD and back to `idle`, but you won't hear it.

Once the decoder is in, say "Hi ESP, what time is it?" toward the device. Expect:
1. LCD goes `idle → listening → thinking → speaking → idle`
2. After ~1–3 s on a Pi 5, you hear Gurney reply through the speaker
3. Server log shows the full pipeline:
   ```
   speaker turn closed { pcmBytes: 48000, reason: 'silence' }
   llm dispatch  { profile: 'chat', maxTokens: 200 }
   ```

---

## 8. Bench bring-up TODOs

These three items are flagged `TODO(bench)` in code. They each need scope time on the actual board and aren't blocking the rest of the firmware.

### 8a. GC9A01 panel init (`ui.c`)

`ui_task()` calls `lv_init()` but doesn't yet bring up the LCD's `esp_lcd_panel` + draw buffers. Rough shape:
```c
esp_lcd_panel_io_handle_t io_h;
esp_lcd_new_panel_io_spi(SPI2_HOST, &io_cfg, &io_h);
esp_lcd_panel_handle_t panel_h;
esp_lcd_new_panel_gc9a01(io_h, &panel_cfg, &panel_h);
esp_lcd_panel_reset(panel_h);
esp_lcd_panel_init(panel_h);
esp_lcd_panel_disp_on_off(panel_h, true);
// then register lvgl's lv_disp_drv_t + flush callback
```
There are good Espressif examples in `$IDF_PATH/examples/peripherals/lcd/`.

### 8b. INMP441 sample bit alignment (`audio_in.c`)

INMP441 emits a 24-bit signed sample left-justified inside a 32-bit I2S slot. The current code shifts `>>16` to get an int16. Depending on how you wired the L/R pin and which I2S slot mode the board ships with, you may need `>>14` instead. Easiest check: feed the int16 buffer into a serial log periodically and verify it varies with sound — silence should be near 0, claps should swing thousands.

### 8c. Opus decoder (`audio_out.c`)

The `decode_opus_stub()` function in `audio_out.c` returns silence so the I2S timing can be tested in isolation. Real implementation uses `esp_audio_codec`'s ogg+opus decoder; once you've pinned the component version, replace the stub body with the decoder feed/fetch sequence. The function signature can stay the same — that's intentional.

---

## 9. Troubleshooting

| Symptom | Likely cause |
|---|---|
| `welcome rejected (reason=auth)` in serial log | `--secret` doesn't match `gurney config gurney-speaker device_shared_secret` |
| Device never gets an IP | WiFi creds wrong in NVS, or 5 GHz-only network (ESP32-S3 is 2.4 GHz only) |
| Connects then disconnects every few seconds | `ws://` URL has the wrong port, or the Gurney server isn't on the listening port |
| Wake word doesn't fire on "Hi ESP" | Mic bit alignment (see 8b) or `esp-sr` model not in the partition. Re-run `idf.py reconfigure` after editing `idf_component.yml`. |
| Audio reply is silent but pipeline runs | Opus decoder stub (see 8c) — expected for v0.1 |
| Buttons fire continuously | Floating GPIO. Either wire the button to GND properly or comment out the spare pin if you haven't soldered it yet |
| `parttool.py: command not found` | Run `. $IDF_PATH/export.sh` again — the parttool script is exported alongside `idf.py` |
| Build fails on `lvgl/lvgl` | First-time component manager fetch may need a clean: `rm -rf managed_components dependencies.lock && idf.py reconfigure` |

---

## 10. What's next

- The Opus decoder + GC9A01 panel are the two big unlock items.
- Custom "Hey Gurney" wake-word model — train one via Espressif's [model generator](https://github.com/espressif/esp-skainet) and drop the binary into the project; change `wake.model_id` in NVS to point at it.
- Multi-device support — v0.1 uses a single shared secret; v0.2 will move to per-device keys once the protocol gets a `device_id`-keyed auth path.
- OTA updates — partition layout already leaves space for a second app slot; the upgrade flow isn't wired yet.
