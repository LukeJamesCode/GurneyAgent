# gurney-voice — design

Working plan to (a) rename `gurney-tts` → `gurney-voice` and (b) add voice-in (Telegram voice note → transcript → orchestrator). Delete this file after implementation lands. This is a planning doc, not a shipping doc.

Decisions baked in (from prior turn):

- **STT engine:** whisper.cpp (mirrors Piper's binary+model pattern).
- **STT UX:** transcribe → run orchestrator. The transcript becomes the user turn; the bot replies normally, and (if `/voice on`) ships a voice reply alongside it.
- **Data migration:** existing `gurney-tts` settings + `tts_chat_prefs` rows are migrated, so users keep `/voice on` and their selected Piper voice without re-running setup.

## 1. Scope

In-scope:

1. Rename the extension and all references (folder, manifest, docs, registry, settings table key, migration table).
2. New core hook so the Telegram adapter routes voice notes to extensions.
3. STT pipeline in the renamed extension: download whisper.cpp + a model, decode OGG/Opus → 16 kHz mono WAV via ffmpeg (already installed), run whisper, return transcript.
4. UX: bot sends a short ack ("🎤 transcribing…"), then runs the orchestrator on the transcript and replies as normal.
5. SQLite data migration on first load.
6. Tests for: STT pipeline (with stubbed whisper), the new core hook, the rename migration.

Explicitly out-of-scope for this change:

- Streaming/partial transcription.
- Diarization or multi-speaker handling.
- Languages beyond what the chosen whisper model supports out of the box.
- Wake-word / always-listening modes.

## 2. Rename — gurney-tts → gurney-voice

Touch list (28 files have `gurney-tts` references; only the load-bearing ones below need code-level changes, the rest are docs/text):

**Code/data:**

- `extensions/gurney-tts/` → `extensions/gurney-voice/` (folder rename).
- `manifest.json`: `name: "gurney-voice"`, version bumped to `0.2.0`, description updated, new `telegram_commands` entry stays as `voice` (the `/voice on|off|status` command keeps its name; we extend the parser to also accept `/voice transcribe on|off`).
- `extensions/registry.json`: rename entry, update `subpath` and `description`.
- `src/cli/ext-setup.ts`, `src/cli/start.ts`, `src/adapters/telegram.ts`, `src/core/extensions.ts`: any hard-coded `gurney-tts` string flips to `gurney-voice`. Confirmed these are name lookups for built-in setup / state-dir paths, not part of a public API.
- `package.json`: scripts/paths only — no runtime API.

**SQLite data migration (extension-owned, new `0002_rename_from_tts.sql`):**

```sql
-- Copy settings if the new extension has none yet.
INSERT OR IGNORE INTO extension_settings (extension, key, value, updated_at)
SELECT 'gurney-voice', key, value, updated_at
FROM extension_settings WHERE extension = 'gurney-tts';

-- Per-chat prefs: keep the same physical table name (`tts_chat_prefs`) for now.
-- Renaming the table is a separate optional cleanup; preserving the name keeps
-- the migration trivially reversible and avoids a long-lived ALTER.
```

Rationale: the table is private to this extension. Renaming it costs us reversibility for no functional gain. We can rename in a later 0.3.x once we're confident no rollbacks are needed.

**State directory:** `~/.gurney/extension_state/gurney-tts/` → `~/.gurney/extension_state/gurney-voice/`. The loader currently mkdirs `<stateRoot>/<name>/` on first load (`src/core/extensions.ts:678`). On startup the rename migration step (run inside `setup.ts`, not SQL) checks for the old path and moves it — voices/, native/ binaries, downloaded models all migrate intact, no re-download.

**Docs:** `docs/extensions/gurney-tts.md` → `docs/extensions/gurney-voice.md`; mentions in `docs/index.md`, `docs/telegram-commands.md`, `docs/database-schema.md`, `docs/troubleshooting.md`, `docs/hardware-and-performance.md`, `docs/deploying-on-raspberry-pi.md`, `docs/extension-authoring.md`, `README.md`, `CHANGELOG.md`, `SECURITY.md`. Mechanical search-and-replace.

`extensions/gurney-tts/README.md` stub stays for one minor release as a redirect → `gurney-voice`. Drop after 0.3.x.

## 3. Core change — voice-message hook

Today the Telegram adapter (`src/adapters/telegram.ts:1015`) only listens on `message:text`. Voice notes are dropped silently.

**Add:** a `bot.on('message:voice')` handler in the adapter, and a matching extension hook on the Host.

**Host API additions** (in `src/core/extensions.ts`):

```ts
export interface TelegramVoiceMessage {
  chatId: number;
  userId: number;
  fileId: string;            // grammY File ID, opaque to extensions
  durationSec: number;
  mimeType?: string;
  log: Logger;
  // Pull the OGG/Opus bytes onto local disk. Adapter-provided.
  downloadToFile: (destPath: string) => Promise<void>;
}

export type TelegramVoiceHandler = (
  msg: TelegramVoiceMessage
) => Promise<{ transcript: string } | { skip: true } | void>;

// On Host.telegram:
onVoiceMessage: (handler: TelegramVoiceHandler) => void;
```

Semantics:

- Adapter calls every registered voice handler in order until one returns a `{ transcript }`. The transcript is then injected into the same `dispatchOrchestratorTurn` path as a typed message would have been. afterReply hooks still fire — so `/voice on` users get a spoken reply for their spoken question, which is the point.
- `{ skip: true }` means "I don't want this one" (e.g. duration over a configured cap). The adapter falls through to the next handler, then if nothing handles it sends a polite "voice notes aren't enabled — type your message".
- Errors are caught by the adapter and logged; the user gets a soft "couldn't transcribe that, sorry" reply rather than nothing.
- Disposer recorded on the extension's registration record, same pattern as `afterReply`.

**Adapter wiring** in `src/adapters/telegram.ts`:

- `bot.on('message:voice')` → resolve `ctx.message.voice.file_id` → `ctx.api.getFile()` to get a `file_path` → expose `downloadToFile` that streams via `bot.api.getFileLink()`.
- The injected text turn reuses the existing intercept chain and orchestrator dispatch — no parallel reply pipeline.
- Allowlist check stays in place (same `ctx.from.id` guard as text messages).

This is one new hook and ~80 lines of adapter code; smaller than the existing `sendVoice` plumbing.

## 4. STT pipeline in gurney-voice

New files in `extensions/gurney-voice/`:

- `stt.ts` — pure pipeline. Inputs: `{ oggPath, whisperBin, ffmpegBin, modelPath, language? }`. Steps:
  1. `ffmpeg -i in.ogg -ar 16000 -ac 1 -f wav out.wav` (whisper needs 16 kHz mono).
  2. `whisper-cli -m <model> -f out.wav -nt -otxt` → read the produced `.txt`.
  3. Trim, normalise whitespace, return.
     Cleans up tempfiles. Designed for an in-memory `runShell` stub like `synth.ts` has, so tests can run without whisper installed.
- `stt.test.ts` — stubs `runShell`, asserts the right argv + that cleanup runs even on failure.
- `voice-in.ts` — registers the new `onVoiceMessage` handler. Reads per-chat "voice-in enabled" pref (new boolean, same table), gates on duration cap, downloads to temp, calls stt.ts, returns `{ transcript }`.
- `setup.ts` — extend with `ensureWhisperForTts` (binary download, same release-asset shape Piper uses) and `ensureWhisperModel` (download ggml model into `~/.gurney/extension_state/gurney-voice/whisper-models/`). Defaults: `ggml-base.en` on Standard/Heavy, `ggml-tiny.en` on Small (mirrors the tier-aware default that Piper uses).
- `commands.ts` — extend `/voice` to also handle `transcribe on|off|status` subcommand. Keeps everything under one Telegram command rather than adding `/transcribe`.

**Settings schema additions** (`settings.schema.json`):

```json
"whisper_bin": { "type": "string", "default": "whisper-cli", ... },
"whisper_model_path": { "type": "string", "secret": true, ... },
"whisper_model_id": { "type": "string", "default": "ggml-base.en", ... },
"stt_max_duration_sec": { "type": "number", "default": 120, ... },
"stt_language": { "type": "string", "default": "auto", ... },
"stt_default_enabled": { "type": "boolean", "default": false, ... }
```

**Per-chat pref:** add a second boolean to `tts_chat_prefs` via migration `0003_stt_pref.sql`:

```sql
ALTER TABLE tts_chat_prefs ADD COLUMN stt_enabled INTEGER NOT NULL DEFAULT 0;
```

Same table, two booleans (`enabled` = TTS out, `stt_enabled` = STT in). Keeps the join trivial and the row count low.

## 5. UX

Happy path:

1. User sends a 6-second voice note.
2. Bot acks within ~150ms: `🎤 transcribing…` (deleted/edited after, or left in place — kept simple, just send-and-leave for v1).
3. Whisper runs (~0.5-2× realtime for `tiny.en`, ~2-4× realtime for `base.en` on a Pi 5).
4. Transcript is fed to the orchestrator. The bot replies normally; if `/voice on`, a voice reply follows.

Edge cases:

- `stt_max_duration_sec` exceeded → reply "voice note too long (>120s)" and don't transcribe.
- `transcribe off` for the chat → reply with the "transcribe is off, use /voice transcribe on" hint, once per session (cache in fast-cache to avoid spam).
- Whisper fails (binary missing, model corrupt, exit non-zero) → reply "couldn't transcribe that, sorry"; log warn; no orchestrator call.
- Transcript empty after trim → reply "I didn't catch anything in that recording".

## 6. Hardware tiers

| Tier     | Default whisper model | Approx model size | Notes                                                          |
| -------- | --------------------- | ----------------- | -------------------------------------------------------------- |
| Small    | `ggml-tiny.en`        | ~75 MB            | English only; Pi 4 friendly; ~0.5-1× realtime.                 |
| Standard | `ggml-base.en`        | ~142 MB           | English only; default for mini-PC tier.                        |
| Heavy    | `ggml-base.en`        | ~142 MB           | Same; bump to `ggml-small.en` (~466 MB) optional via settings. |

`gurney init`'s tier detector picks the default via `whisper_model_id`. Users can override with `gurney config gurney-voice whisper_model_id ggml-small`.

## 7. Risks / open issues

1. **Latency on Small tier.** A 30s voice note on a Pi 4 with `tiny.en` could push toward 30-45s of transcription. The acks help, but if it's worse than expected we should consider making STT a background job that posts the transcript+reply as a fresh message (similar shape to the briefings cron). Defer until measured.
2. **whisper.cpp release asset names.** Their releases aren't as uniform as Piper's; the binary auto-install code will need a slightly different `assetFor(platform, arch)` table. Acceptable — Piper showed us the pattern.
3. **OGG/Opus quirks.** Telegram voice notes are technically OGG containers with Opus. ffmpeg handles this, but the `-ar 16000 -ac 1 -f wav` invocation has to be exact. Cover with a stt.test.ts argv assertion.
4. **Concurrent transcriptions.** Two voice notes arriving back-to-back will queue serially on the user's CPU. The existing in-process background queue (per `CLAUDE.md`) handles this naturally — just dispatch via that queue rather than inline. Not a new piece of infrastructure.
5. **`gurney-tts/README.md` redirect lifetime.** One minor release is short; if the registry caches by name we should keep it for two. Decide when 0.2.0 ships.
6. **Tests for the new hook in the adapter.** `src/adapters/telegram.ts` doesn't have a dedicated test file for `bot.on(...)` paths (the existing tests focus on commands and quiet/help logic). The new voice path needs a unit test that stubs grammY's Context — about the same shape as the existing intercept tests.

## 8. Implementation order (next session)

1. Rename in place — folder + manifest + registry + state-dir migration in setup.ts. Land first as its own commit; ship the redirect stub; verify existing `/voice` users still work end-to-end.
2. Add the `onVoiceMessage` host hook and the adapter wiring. Land with a no-op handler in `gurney-voice` that just replies "not implemented yet" — proves the plumbing in isolation.
3. Add `stt.ts` + tests with stubbed shell.
4. Add whisper binary + model bootstrap to `setup.ts` + tests.
5. Wire `voice-in.ts` to the real pipeline; extend `/voice` command parser.
6. Docs sweep + CHANGELOG entry + bump manifest to 0.2.0.

Each step is independently revertable. Steps 1 and 2 are the only ones that touch core; 3-5 stay inside the extension.

## 9. Success criteria

- `gurney ext install gurney-voice` runs setup, downloads piper + whisper binaries and the default voice + STT models, with clear progress lines.
- `/voice on` still works exactly as before (TTS-out unchanged).
- `/voice transcribe on` then sending a voice note → bot replies in text (and, if TTS is on, in voice) with a sensible answer to the spoken question.
- Existing users on `gurney-tts` who pull `gurney-voice` keep their voice replies working with zero config touch.
- Unit tests pass (`npm test`); typecheck clean; lint clean.
- One full manual round-trip on the maintainer's Pi 5 before tagging.
