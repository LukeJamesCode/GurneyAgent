# gurney-speaker — setup guide

End-to-end setup walkthrough for the gurney-speaker extension + ESP32-S3 firmware. Steps below mirror what's actually been validated end-to-end (boot → WiFi → WebSocket → buttons round-tripping with the server → orchestrator dispatch → TTS). Subsystems still in bring-up (LCD panel, Opus decode in firmware) are flagged.

This guide covers everything from a fresh `gurney fresh` install on your server through to a Gurney puck connecting back over WiFi.

---

## What you need

**Server box** (Pi, mini-PC, whatever Gurney runs on)

- Working Gurney install with `gurney-voice` already set up — the speaker extension piggybacks on the whisper + Piper models gurney-voice downloads.
- LAN connectivity to your puck device.

**Dev machine** (where you build the firmware — Windows/macOS/Linux)

- ESP-IDF **v5.5.x** (see Step 2 — **avoid v6.0.x**; esp-sr requires a `json` component that v6 removed).

**Hardware** — see `firmware/gurney-speaker/README.md` for the hardware target list and pin map.

---

## 1. Server side — install the extension

On the server:

```bash
gurney ext install gurney-speaker
```

This pulls the extension, runs the migration, and `setup.ts` auto-generates a `device_shared_secret`. Tell it your gurney-voice paths and which Telegram chat the device should post into:

```bash
gurney config gurney-speaker whisper_model_path "$HOME/.gurney/extension_state/gurney-voice/whisper-models/ggml-base.en.bin"
gurney config gurney-speaker voice_model_path  "$HOME/.gurney/extension_state/gurney-voice/voices/en_GB-northern_english_male-medium.onnx"
gurney config gurney-speaker owner_chat_id <your Telegram chat ID>
```

> Setting `owner_chat_id` is what flips the device from "stateless LLM chat" to "full Gurney with tools, memory, and shared conversation history with your Telegram chat". Leave it at `0` if you want each puck to be a single-turn voice toy with no side effects.

Then start Gurney:

```bash
gurney start
gurney logs -f | grep speaker
```

You're looking for:

```
gurney-speaker ws server listening { host: '0.0.0.0', port: 7820 }
```

> **Gotcha we hit:** earlier `gurney config` flows could pack a `host:port` value into `listen_host`. The current ws-server tolerates this (logs a warning, splits cleanly) but you can clean it up by running `gurney config gurney-speaker` and resetting `listen_host` to `0.0.0.0`, or deleting the row from SQLite directly:
>
> ```bash
> # sqlite3 may not be installed; the Node REPL works fine too:
> node -e "const D=require('better-sqlite3');const d=new D(process.env.HOME+'/.gurney/gurney.db');d.prepare(\"DELETE FROM extension_settings WHERE extension='gurney-speaker' AND key='listen_host'\").run();"
> ```

Open port **7820/tcp** on the server's firewall if you have one (`sudo ufw allow 7820/tcp`).

## 2. Server side — grab the two values you need for provisioning

You need the **device secret** and the **server LAN IP**. Read the secret directly from the SQLite store:

```bash
node -e "const D=require('better-sqlite3');const d=new D(process.env.HOME+'/.gurney/gurney.db',{readonly:true});console.log(d.prepare(\"SELECT value FROM extension_settings WHERE extension='gurney-speaker' AND key='device_shared_secret'\").get());"
```

Save the `value` string. Then get the server IP:

```bash
hostname -I    # Linux
ipconfig       # Windows
```

Your firmware will connect to `ws://<server-ip>:7820/`.

---

## 3. Dev machine — install ESP-IDF v5.5.x

> **Important:** use ESP-IDF **v5.5.x** (or 5.4). **Do not** use v6.0.x for v0.1 — esp-sr depends on a `json` component that v6 dropped, and the build will fail with "Failed to resolve component 'json' required by component 'espressif\_\_esp-sr'".

Use the [ESP-IDF Installation Manager (EIM)](https://docs.espressif.com/projects/idf-im-ui/en/latest/). After the GUI installs ESP-IDF, you may need to bootstrap the Python venv manually if EIM didn't:

```powershell
cd <path-to>\v5.5.3\esp-idf
.\install.ps1 esp32s3
```

Drivers: if your board uses a CH343/CH340 USB-to-UART chip (most cheap S3 boards do), install the WCH driver from `wch-ic.com`. CP210x driver from Silicon Labs covers the other common chip.

Verify with:

```powershell
. .\export.ps1
idf.py --version
```

Should print `ESP-IDF v5.5.x`.

## 4. Dev machine — configure VS Code (optional but recommended)

Install the **ESP-IDF** extension (`espressif.esp-idf-extension`) from the marketplace.

Create `firmware/gurney-speaker/.vscode/settings.json` (this file is **gitignored** because the paths are machine-specific). Use these keys, swapping in your local paths:

```json
{
  "idf.espIdfPathWin": "C:\\path\\to\\v5.5.3\\esp-idf",
  "idf.toolsPathWin": "C:\\Users\\<you>\\.espressif",
  "idf.pythonInstallPath": "C:\\Users\\<you>\\.espressif\\python_env\\idf5.5_py3.13_env\\Scripts\\python.exe",
  "idf.gitPath": "C:\\Program Files\\Git\\cmd\\git.exe",
  "idf.adapterTargetName": "esp32s3",
  "idf.flashType": "UART",
  "idf.portWin": "COM4",
  "idf.currentSetup": "C:\\path\\to\\v5.5.3\\esp-idf"
}
```

Linux/macOS users use `idf.espIdfPath`, `idf.toolsPath`, and `idf.port` instead of the `*Win` variants.

> **Gotcha we hit:** EIM's auto-generated PowerShell profile (`Microsoft.v6.0.1.PowerShell_profile.ps1`) has invalid syntax around `$env:'_IDF.PY_COMPLETE'` that aborts the whole profile load. If you see those errors when opening a new terminal, edit that file and either delete the `Register-IdfCompletions` function body or replace it with `return`. Tab completion isn't needed.

## 5. Dev machine — build the firmware

```powershell
cd firmware\gurney-speaker
idf.py set-target esp32s3
idf.py build
```

First build is 5–15 minutes (esp-sr + esp_websocket_client + a few transitive deps download). Subsequent builds finish in under a minute.

> **Gotcha we hit:** if `idf.py` complains about target mismatch or a 2 MB flash size, you may have a stale build. Delete `build/`, `sdkconfig`, `managed_components/`, and `dependencies.lock` and rebuild from scratch.

## 6. Dev machine — provision the NVS partition

The firmware reads WiFi credentials and the server URL from NVS. Build a one-off NVS image using the bundled helper:

```powershell
python tools\provision.py --device-id puck-1 --secret "<paste-secret-from-step-2>" --server-url "ws://<server-ip>:7820/" --wifi-ssid "<your-wifi>" --wifi-psk "<your-password>" --output nvs.bin
```

Double-quote every value — PowerShell treats `#` as a comment marker, so an unquoted `Pa$$#word` would lose everything from `#` onward.

> **Gotcha we hit:** if the script fails with `No module named esp_idf_nvs_partition_gen`, your system Python doesn't have ESP-IDF's deps. The script tries to auto-find the IDF venv; if that fails, invoke it explicitly:
>
> ```powershell
> & "<idf-tools>\python\v5.5.3\venv\Scripts\python.exe" tools\provision.py ...
> ```

The output `nvs.bin` is **gitignored** — it contains your WiFi password in plaintext. Don't share it.

## 7. Dev machine — flash everything

In the IDF terminal (Ctrl+Shift+P → "ESP-IDF: Open ESP-IDF Terminal" if you're in VS Code):

```powershell
idf.py -p COM4 flash
parttool.py -p COM4 write_partition --partition-name nvs --input nvs.bin
idf.py -p COM4 monitor
```

(Replace `COM4` with whatever Device Manager shows for your board.)

`idf.py flash` writes the app **and** the `srmodels.bin` WakeNet model image into the `model` partition automatically — esp-sr's build hook chains that into the flash target. No separate `parttool` step for the wake-word model.

> **Gotcha we hit:** VS Code's bottom-bar ⚡ Flash button defaults to JTAG, which fails on boards without a JTAG adapter. Flash from the terminal as above (UART) instead.

> **Upgrading from v0.1?** Two extra steps before the regular flash:
>
> 1. **Force `sdkconfig` to regenerate from `sdkconfig.defaults`.** Defaults are only applied when `sdkconfig` doesn't exist; the v0.1 sdkconfig has the wrong wake-word model selected and MultiNet on, which inflates `srmodels.bin` past the 3 MB model partition and causes a cache-fault panic on boot:
>     ```powershell
>     Remove-Item sdkconfig
>     Remove-Item -Recurse build  # forces a clean configure too
>     idf.py reconfigure
>     idf.py build
>     ```
> 2. **Erase the flash before the new layout writes.** The partition table grew (a new `model` partition was added). `idf.py flash` won't repartition an already-flashed device, so the chip would otherwise boot from the old partition table and esp-sr would fault when it can't find the model partition at runtime:
>     ```powershell
>     idf.py -p COM4 erase-flash
>     ```
>
> Then proceed with the regular `idf.py flash` + `parttool` NVS step.

A healthy boot looks like:

```
I gs_main: gurney-speaker firmware v0.1.0 booting
I gs_ui:   ui module loaded (display driver deferred — no panel init in v0.1)
I (wifi:) ...
I gs_main: got ip
I gs_ws:   connected, sending hello
I gs_ws:   hello sent (deviceId=puck-1)
I gs_ws:   welcome ok (display=0, vol=0.60, muted=0)
I gs_main: boot complete
```

And on the server:

```
gurney-speaker/ws  device connected  { deviceId: 'puck-1', fwVersion: '0.1.0' }
```

Exit the monitor with **Ctrl+]**.

## 8. Verify the round trip

Press one of your buttons. Server log should show:

```
device button { button: 'vol_up' }
```

Press mute. Device's serial monitor should log `state -> 4` (muted). Press again to unmute.

Then say **"Hi, ESP"** (the placeholder wake phrase — swap it to any other built-in via `idf.py menuconfig` → *ESP Speech Recognition → Wake word model*). The serial monitor should log `wake detected`, server logs should show a turn closing with a transcript, the orchestrator's reply should round-trip back, and the speaker should play the Piper voice.

---

## Known not-yet-working in v0.2

| Subsystem                       | Status                                                                                                                                       |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Boot, NVS, WiFi, reconnect      | ✅ Working                                                                                                                                   |
| WebSocket auth + state sync     | ✅ Working                                                                                                                                   |
| Buttons (vol/mute)              | ✅ Working                                                                                                                                   |
| PTT (spare button)              | ✅ Working — hold to talk, release to end the turn. Works with or without a wake-word model flashed.                                         |
| Wake word                       | ✅ Placeholder "Hi, ESP" (esp-sr `wn9_hiesp`). Custom "Hey Gurney" requires training — see appendix.                                          |
| Mic streaming + STT round trip  | ✅ Working — either via PTT or wake word.                                                                                                    |
| TTS playback                    | ✅ Working (48 kHz OGG/Opus → I2S).                                                                                                          |
| Orchestrator dispatch + tools   | ✅ Working when `owner_chat_id` is set; device shares the orchestrator with Telegram.                                                        |
| Display                         | ⚠️ GC9A01 panel init is a `TODO(bench)` in `ui.c` — backlight comes on but the panel is black.                                               |
| Barge-in                        | ⚠️ Not supported. Wake detection is suppressed while the speaker is active to prevent self-wake; wait for TTS to finish before next utterance. |

## Roadmap from here

- **GC9A01 panel + LVGL** — bring up the round LCD via `esp_lcd_panel` and re-introduce LVGL screens. Add `lvgl/lvgl` to `idf_component.yml`.
- **Custom "Hey Gurney" wake word** — see appendix below.
- **Barge-in / AEC** — wire an echo-reference channel into esp-sr's AFE so the mic can hear past the speaker's own output.

---

## Appendix: Training a custom "Hey Gurney" wake word

`wn9_hiesp` is a stock English WakeNet9 model. Training one for "Hey Gurney" runs entirely offline on a workstation using esp-sr's open-source toolchain. High-level steps:

1. Clone https://github.com/espressif/esp-sr and follow `tools/wakenet/README.md`.
2. Collect / synthesize ~1–2 hours of positive samples ("Hey Gurney") and matched negatives. The repo includes scripts for TTS-augmented synthesis via Piper or similar.
3. Train (Python, GPU-friendly but CPU works for wn9). Output is a directory containing `wn9_hey_gurney.bin` plus metadata.
4. Drop the directory under `firmware/gurney-speaker/managed_components/espressif__esp-sr/model/wakenet_model/` and pick it via `idf.py menuconfig` → *ESP Speech Recognition → Wake word model → User customized model*.
5. Rebuild + `idf.py -p COMx flash`. The model partition is re-flashed automatically.
6. Update `GS_DEFAULT_WAKE_MODEL` in `firmware/gurney-speaker/main/config.h` to the new model id so logs and any future "select model at runtime" code points at the right thing.

Espressif's commercial training service produces tighter false-accept curves but isn't required for hobby use.
