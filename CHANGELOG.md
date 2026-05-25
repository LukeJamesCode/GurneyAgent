# Changelog

All user-visible changes to Gurney. Newest first.

Format: `## [version] — YYYY-MM-DD`

---

## [1.3.0] — 2026-05-25

### Added

- `gurney-speaker` extension: full orchestrator-backed dispatch. When `owner_chat_id` is set the device's voice turns go through Gurney's main orchestrator — same conversation history as Telegram, every registered tool (calendar, reminders, weather, briefings, learned routines, …) callable from voice, and the hallucination guard intact. Without `owner_chat_id` the device falls back to a stateless `host.llm` chat as before.
- `gurney-speaker`: per-device state persistence via the `speaker_devices` table. On reconnect, the welcome frame replays the puck's last-known volume + mute instead of snapping back to the schema defaults.
- `gurney-speaker`: new `speech_max_chars` setting (default 600 ≈ 30s spoken) clips runaway replies on sentence boundaries before they hit Piper.
- Core: new `host.orchestrator.handleUserMessage(...)` host API for extensions that want to submit a user turn into the orchestrator from a non-Telegram surface. Mirrors what `gurney-speaker` now uses; documented in the extension authoring guide implicitly via the speaker.
- Firmware (`firmware/gurney-speaker`): push-to-talk on the spare button (GPIO 39 by default). Hold to talk, release to close the turn. Works whether or not a WakeNet model is flashed — the documented escape hatch when wake word isn't set up yet.

### Fixed

- `gurney-speaker` session: `onStateSync` was firing the persist callback even when the volume/mute hadn't actually changed; now it's idempotent.
- Firmware `ws_client`: the inbound PING echo used the shared TX scratch buffer without holding the mutex, which could collide with an in-flight PCM send on the audio task. Now writes a stack-local 1-byte buffer.
- Firmware `buttons.c`: missing `<string.h>` include (worked transitively but warned with some toolchains).
- `gurney-everyday-assistant`: smoke + hardening tests were stale; the weather-reschedule sweep is now per-time (defaults: 06:00 + 18:00) and the all-day calendar end is Google's exclusive-end convention. Tests updated to match.
- `src/core/orchestrator`: unnecessary escape inside a character class in the fake-tool-call detector.

---

## [1.2.0] — 2026-05-24

### Added

- `gurney-voice` extension: voice-to-text on inbound Telegram voice notes via whisper.cpp. New per-chat command `/voice transcribe on|off|status`. When on, a voice note is transcoded (ffmpeg → 16 kHz mono WAV), transcribed (whisper.cpp), and handed to the orchestrator as if the user had typed it — so a spoken question still gets a spoken reply when `/voice on`.
- Core: new `host.telegram.onVoiceMessage(handler)` extension hook + `bot.on('message:voice')` wiring in the Telegram adapter. Handlers return `{ transcript }` to inject text into the orchestrator path or `{ skip: true }` to pass.
- Whisper.cpp + ggml model auto-install in `gurney ext install gurney-voice` (default `ggml-base.en`; recommend `ggml-tiny.en` on Pi 4).

### Changed

- Renamed `gurney-tts` → `gurney-voice` (it's now two-way: TTS out + STT in). Existing user settings (`piper_bin`, `voice_id`, `voice_model_path`, …) and the per-chat `tts_chat_prefs` table migrate automatically on first load via `0002_rename_from_tts.sql` and a one-time `~/.gurney/extension_state/gurney-tts/ → gurney-voice/` directory move during setup. Pre-downloaded Piper voices and binaries are NOT re-downloaded.

### Notes

- The physical SQLite table name remains `tts_chat_prefs` for reversibility. A new `stt_enabled` column was added to that table (migration `0003_stt_pref.sql`). The two booleans (`enabled` for TTS-out, `stt_enabled` for STT-in) are independent per chat.

---

## [1.1.0] — 2026-05-20

### Changed

- Folded `gurney-routines` into `gurney-everyday-assistant`. The learner + per-minute delivery crons live in the everyday-assistant now and auto-create recurring nudges from observed patterns (nightly schedule prep, repeated reminders, task-review hours). Two new tools — `learned_routine_list` and `learned_routine_delete` — let the user inspect and remove them. New settings: `learned_routines_enabled`, `learned_routines_suggestion_cron`, `learned_routines_delivery_cron`, `max_routines_per_week` (default 3).

### Removed

- `gurney-routines` extension — merged into `gurney-everyday-assistant`. The opt-in suggestion ask-flow (`/routines`, `/routine accept|pause|delete|why`) and the `routine_candidates` / `routine_suggestions` tables are gone; rules are auto-accepted past a hardcoded 0.7 confidence floor, bounded by `max_routines_per_week`.

---

## [1.0.0] — 2026-05-19

First stable public release. Host API for extensions is now stable.

### Changed

- Project status moved from "feature-complete, running release checklist" to **1.0 — shipped**.
- README: trimmed bundled extensions, added a Roadmap section for the 1.x line, and softened pre-1.0 language that implied API providers would never be supported (they're on the roadmap as opt-in, either in core or as an official extension).

### Removed

- `gurney-websearch` extension — pulled to keep the 1.0 bundle lean; planned to return as an official extension during the 1.x line. See the README Roadmap.
- `gurney-memgraph` extension — same reasoning; planned to return as a heavy-tier official extension during the 1.x line.

---

## [0.7.0] — 2026-05-05

Phase 7 in progress — feature-complete; running through the release checklist toward 1.0.

### Added

- `gurney doctor` expanded: disk-space check, port-conflict detection, migration checksum verification, environment-variable drift detection (deprecated and unrecognised `GURNEY_*`/`TELEGRAM_*`/`OLLAMA_*` vars flagged)
- `gurney update` — pull latest code, reinstall deps, rebuild in one command
- `gurney fresh` — wipe all Gurney data, update, and re-run setup wizard
- `gurney status --json` — machine-readable health output
- `gurney ext create <name>` — scaffold a new extension with the standard layout
- Followups table (`0004_followups`): the model can now schedule one-shot future messages via the core `schedule_followup` tool
- Cross-extension nudge dedup and rate-limiting via `nudge_log` table
- Per-chat quiet hours and snooze via `chat_prefs` table
- `gurney-instant-responses` extension — templated instant replies for trivial chatter and tool-dispatch acks
- `docs/extension-authoring.md` — complete extension development guide
- `docs/release-checklist.md` — 1.0 release gates

### Changed

- `gurney doctor` now exits non-zero when any check fails (was always 0 in v0.6)
- Extension loader partial-load safety: if any entrypoint throws mid-load, disposers run in LIFO order to prevent stale registrations

---

## [0.6.0] — Phase 6

Phase 6 — proactive polish.

### Added

- Quiet hours (`chat_prefs` table): per-chat daily window during which nudges are suppressed
- One-shot snooze: `paused_until_ms` in `chat_prefs`
- `nudge_log` table: append-only record of every dispatched nudge, used for cross-extension rate-limiting and dedup
- Fast-cache hit-rate visible in `gurney status`

---

## [0.5.0] — Phase 5

Phase 5 — `gurney-memgraph` and `gurney-tts`.

### Added

- `gurney-memgraph` extension: long-term memory via FalkorDB + Graphiti HTTP bridge. Tools: `recall_memory`, `store_memory`. Commands: `/memory`, `/remember`, `/forget`. Background extraction sweep.
- `gurney-tts` extension: voice replies via Piper (ONNX, CPU). Command: `/voice on|off|status`. After-reply hook synthesizes voice notes out-of-band.

---

## [0.4.0] — Phase 4

Phase 4 — remaining starter extensions.

### Added

- `gurney-google-tasks`: Google Tasks via natural language. Tools + commands (`/todos`, `/todo`, `/done`, `/tasks`).
- `gurney-reminders`: one-shot local reminders. Tools + commands (`/remind`, `/reminders`). Background sweep.
- `gurney-weather`: current conditions + 4-day forecast via Open-Meteo (no API key). Tool + command (`/weather`).
- `gurney-websearch`: DuckDuckGo / SearXNG web search LLM tool.
- `gurney-briefing`: morning and evening briefing aggregation. Commands (`/morningbrief`, `/nightbrief`) + scheduled cron delivery.
- `intent_pattern` field in `manifest.json`: per-extension message routing regex that prunes the LLM's tool manifest to only relevant extensions per turn.
- `selfReplying` tool flag: action tools bypass the follow-up LLM paraphrase call.
- Tools model profile (`GURNEY_TOOLS_MODEL`): separate model for tool-selection turns.

---

## [0.3.0] — Phase 3

Phase 3 — CLI and TUI.

### Added

- `gurney init`: first-run wizard (Telegram token, allowlist, Ollama URL, model selection, hardware tier)
- `gurney config`: interactive TUI for core and extension settings
- `gurney auth <ext>`: terminal-bound extension auth flow with local OAuth callback server
- `gurney models`: model-picker re-run
- `gurney ext list/install/enable/disable/uninstall/reload`: full extension management
- `gurney start --detach`: background daemon with PID file
- `gurney stop`: SIGTERM to the daemon
- `gurney logs [--follow]`: stream the log file
- `gurney status`: one-shot health summary
- `gurney doctor`: preflight diagnostics (config, telegram, ollama, ram, extensions, migrations)
- `~/.gurney/config.json` (mode 0600): persisted config source of truth; env vars still win at runtime
- Hardware tier auto-detection from total RAM + CPU count
- File sink for the logger (`~/.gurney/log/gurney.log`)

---

## [0.2.0] — Phase 2

Phase 2 — extension system and proactive scheduler.

### Added

- Extension loader: discovery, manifest validation, capability gating, hot-reload via filesystem watch
- Host API: `tools.register`, `telegram.command/intercept`, `scheduler.cron`, `prompts.contribute`, `auth.flow`, `settings.get/set`, `cache.getOr`, `db`, `llm`, `log`, `dataDir`
- Per-extension SQLite migrations via `_ext_<name>_migrations` table
- Core scheduler: minute-granularity cron tick, nudge dispatcher
- Fast-cache: per-extension TTL memoization
- `gurney-google-calendar` extension: four tools, four slash commands, OAuth auth flow, settings schema, cron event-reminder sweep, per-extension migration
- `0002_extensions` migration: `extension_state` + `extension_settings` tables
- `0003_proactive` migration: `chat_prefs` + `nudge_log` tables (infrastructure for Phase 6)

---

## [0.1.0] — Phase 1

Phase 1 — core conversation loop.

### Added

- Structured logger with secret redaction
- SQLite + numbered migrations (`0001_init`): conversations, messages, session_memory, telegram_chats, scheduled_tasks, job_queue
- Ollama HTTP client: profile routing (chat/reason), heavy-model eviction, circuit breaker, streaming
- Context manager: deterministic-prefix prompt assembly (system → tools → memory → session → history), token budgeting
- Tool engine: registration API, `auto`/`confirm`/`owner` permission tiers
- Two-queue orchestrator: per-chat user queue + background job worker
- grammY Telegram adapter: long-poll, allowlist enforcement, core slash commands (`/start`, `/help`, `/newchat`, `/stop`, `/model`, `/status`, `/lasterror`, `/extensions`, `/devmode`)
- `gurney start` wires everything together

---

## [0.0.0] — Phase 0

Phase 0 — skeleton.

### Added

- Repository, TypeScript, ESLint, Prettier
- `package.json`, `tsconfig.json`
- GitHub Actions CI (lint, typecheck, test on Node 20 + 22; docker compose config)
- `docker-compose.yml` (gurney + ollama; falkordb commented)
- `.env.example`
- MIT license
