# gurney-voice

Two-way Telegram voice. Outbound replies via [Piper](https://github.com/rhasspy/piper) (ONNX neural TTS, CPU-only). Inbound voice notes transcribed via [whisper.cpp](https://github.com/ggerganov/whisper.cpp) (CPU-only). [ffmpeg](https://ffmpeg.org/) sits between Telegram's OGG/Opus and the engines on both sides.

> Renamed from `gurney-tts` in 0.2.0. Existing user settings and per-chat preferences are migrated automatically on first load — `/voice on` users keep their selected voice and don't need to re-run setup.

## What it adds

- `/voice on|off|status` — flips a per-chat preference. When on, the bot ships a voice note alongside every text reply.
- `/voice transcribe on|off|status` — flips per-chat voice-to-text. When on, Telegram voice notes are transcribed by whisper.cpp and handed to the orchestrator as if you'd typed them.
- An after-reply hook on the orchestrator (TTS out) and a voice-message handler (STT in). Both run out-of-band — a synth or transcription failure logs and skips, never blocks the conversation.

## Setup

1. Install the extension:

   ```sh
   gurney ext install gurney-voice
   ```

   Setup auto-configures the native binaries and models:
   - **Piper** is downloaded into `~/.gurney/extension_state/gurney-voice/native/` and `piper_bin` is set to that executable.
   - **whisper.cpp** is detected from `$PATH` (`whisper-cli`, `whisper-cpp`, `whisper` are all probed). If missing, setup offers to install it with the platform's package manager (Homebrew on macOS / linuxbrew, `pacman` on Arch). Debian/Ubuntu users currently install whisper.cpp manually; set `whisper_bin` with `gurney config gurney-voice whisper_bin <path>` after building.
   - **ffmpeg** is detected from `$PATH`; if missing, setup offers to install it with `apt-get`, `dnf`, `pacman`, `apk`, `zypper`, Homebrew, `winget`, Chocolatey, or Scoop.
   - The default Piper voice (`en_GB-northern_english_male-medium`, ~63 MB) and the default whisper model (`ggml-base.en`, ~142 MB) are downloaded immediately.

   Setup does not prompt for `piper_bin`, `whisper_bin`, or `ffmpeg_bin`. If auto-setup cannot handle your platform, install the binaries manually and set the paths with `gurney config`.

2. Optional: run `gurney auth gurney-voice` if you want to choose a different Piper voice. Press Enter / answer `no` to keep the default.

3. In a Telegram chat with the bot:
   - `/voice on` — bot replies become voice notes (in addition to text).
   - `/voice transcribe on` — send the bot voice notes and it'll transcribe + answer them.

## Picking models per tier

| Tier      | Default whisper model | Approx size | Notes |
| --------- | --------------------- | ----------- | ----- |
| Small (Pi 4)     | `ggml-tiny.en`  | ~75 MB  | English only; ~0.5-1x realtime on a Pi 4. |
| Standard (mini-PC)  | `ggml-base.en` | ~142 MB | English only; default. |
| Heavy (5800H+)   | `ggml-base.en`  | ~142 MB | Or bump to `ggml-small.en` (~466 MB) via `gurney config gurney-voice whisper_model_id ggml-small.en`. |

Override with `gurney config gurney-voice whisper_model_id <id>`. The new model auto-downloads on next launch.

## Resource notes

- A Piper voice model is ~60-100 MB resident during synthesis; whisper-tiny/base is ~75-150 MB. On a Pi 4 expect ~1x realtime for both. The bot ships the text reply first so the voice note arriving a moment later is fine.
- A 30-second voice note on a Pi 4 with `ggml-tiny.en` may take 30-45 seconds to transcribe. The bot stays unresponsive for that chat during transcription — keep notes short or move to a beefier tier.
- TTS + STT are opt-in / Heavy tier for a reason — don't enable both on the smallest tier without measuring.

## Limits

- Replies longer than `max_chars` (default 600) are skipped — voice notes for long replies are punishing to listen to.
- Code blocks are stripped before synth; the voice note says "code omitted".
- Voice notes longer than `stt_max_duration_sec` (default 120s) are skipped before whisper runs.
- Both hooks are fire-and-forget: a Piper, whisper, or ffmpeg crash logs and moves on; the conversation continues in text.
