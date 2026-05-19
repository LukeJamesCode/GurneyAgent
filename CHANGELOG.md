# Changelog

All user-visible changes to Gurney. Newest first.

Format: `## [version] — YYYY-MM-DD`

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
