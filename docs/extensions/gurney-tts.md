# gurney-tts

Voice replies via [Piper](https://github.com/rhasspy/piper) (ONNX neural TTS, runs on CPU) and [ffmpeg](https://ffmpeg.org/) for the OGG/Opus encode that Telegram voice notes need.

## What it adds

- `/voice on|off|status` — flips a per-chat preference. When on, the bot ships a voice note alongside every text reply.
- An after-reply hook on the orchestrator that synthesizes and sends the audio. Synth runs out-of-band — a TTS failure never blocks the text reply.

## Setup

1. Install the extension:

   ```sh
   gurney ext install gurney-tts
   ```

   Setup auto-configures the native binaries:
   - Piper is downloaded into `~/.gurney/extension_state/gurney-tts/native/` and `piper_bin` is set to that executable.
   - `ffmpeg` is detected from `PATH`; if missing, setup offers to install it with `apt-get`, `dnf`, `pacman`, `apk`, `zypper`, Homebrew, `winget`, Chocolatey, or Scoop. The resolved executable is written to `ffmpeg_bin`.
   - The selected voice model and config are downloaded immediately into `~/.gurney/extension_state/gurney-tts/voices/`, and `voice_model_path` is set to the downloaded `.onnx`.

   The setup wizard does not prompt for `piper_bin` or `ffmpeg_bin`. If auto-setup cannot handle your platform, install the binary manually and set the path with `gurney config`.

2. Optional: run `gurney auth gurney-tts` if you want to choose a different Piper voice. Press Enter / answer `no` to keep the Northern English male default.
3. In a Telegram chat with the bot: `/voice on`.

That's it. Setup downloads the default voice — **en_GB-northern_english_male-medium** (male, British Northern English, ~63 MB) — from the rhasspy/piper-voices Hugging Face mirror into `~/.gurney/extension_state/gurney-tts/voices/`. If setup could not download it, the extension will try again on first voice reply.

To use a different voice, download an `.onnx` from <https://huggingface.co/rhasspy/piper-voices/tree/main> and point `voice_model_path` at it via `gurney config gurney-tts`. Leave `voice_model_path` blank for the default auto-download path. `piper_bin` and `ffmpeg_bin` default to the binary names on `$PATH`; override them only if you installed somewhere unusual.

## Resource notes

A Piper voice model is roughly 60–100 MB resident during synthesis. On a Pi 4 expect ~1× realtime synthesis for medium voices; the bot ships the text reply first so the voice note arriving a moment later is fine.

TTS is opt-in / Heavy tier for a reason — don't enable on the smallest tier without measuring.

## Limits

- Replies longer than `max_chars` (default 600) are skipped — voice notes for long replies are punishing to listen to.
- Code blocks are stripped before synth; the voice note says "code omitted".
- This is fire-and-forget: a Piper or ffmpeg crash logs and moves on, the user still has the text reply.
