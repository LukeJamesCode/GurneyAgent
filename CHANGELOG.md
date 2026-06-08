# Changelog

All user-visible changes to Gurney. Newest first.

Format: `## [version] — YYYY-MM-DD`

---

## [Unreleased]

### Added

- **Multi-agent engine (core).** Gurney can now run named **agent personas** — each a saved bundle of orchestrator options (system prompt, model profile, tool allowlist, tool-round cap) plus an execution policy. Agents run headlessly through the normal orchestrator pipeline against a reserved virtual chat id, so every guard (per-turn tool gate, hallucination scrubbing, timeouts) applies for free. New core modules: `src/core/agents.ts` (registry + runtime), `src/core/agent-queue.ts` (scheduler), `src/core/agent-delegation.ts` (delegation tool); migration `0009_agents.sql`.
- **Resource-aware task queue.** A background queue runs dispatched tasks under a model-resource governor: **at most one heavy (7–9B) task at a time** (so two reasoning agents never thrash the single resident model slot on a Pi), while tiny (0.5–0.8B) tasks run in parallel up to a tier-scaled cap (Small 1 / Standard 2 / Heavy 3). Each agent additionally picks `sequential` or `parallel` execution. Interrupted tasks are re-queued on restart.
- **Supervisor → worker delegation.** A built-in `spawn_agent` tool (visible only to agents marked _can delegate_) lets a lead agent break a task into subtasks handled by specialists, `await` their results, and synthesise. Safety is enforced in code: a worker's tool grant is the **intersection** of the supervisor's grant and its own (delegation can never escalate), delegation depth is capped, and a `confirm`/`owner`-tier tool in an unattended background run **fails closed**.
- `gurney-frontend`: an **Agents command center** — a new panel tab to create/edit personas, dispatch tasks, and watch them stream through queued → running → done with their transcript and sub-agent tree. New `/api/agents*` routes; the daemon stays the single task executor (the panel only does CRUD + dispatch).
- A starter fleet (**planner**, **researcher**, **writer**, **critic**) is seeded on a fresh install to show the pattern.
- **Human-in-the-loop approvals for risky agent steps.** When a background agent calls a `confirm`-tier tool — or the new built-in **`request_approval`** tool it can invoke to pause on anything it judges risky — the daemon no longer fails closed: it **parks the call and asks the owner**. The prompt is pushed to **Telegram with ✅/❌ buttons** and shown in the panel's **Approvals** card; the step only runs if approved, and waits until a human answers (cancelling the task releases it). Decisions from either surface resolve the same parked call (Telegram in-process, panel via the shared DB). New `src/core/agent-approvals.ts`, migration `0011_agent_approvals.sql`, and `/api/agents/approvals*` routes.
- **Parallel agent fan-out (`spawn_agents`).** A delegating agent can now dispatch several lightweight workers at once and join their labelled results in a single tool call — the parallel-decomposition pattern the engine was built for (e.g. gather calendar + tasks + weather concurrently, then synthesise). Workers run with a tier-bounded concurrency cap (Small 1 / Standard 2 / Heavy 3) so a Pi never over-loads RAM; heavy (reasoning) targets are refused to avoid a single-slot deadlock; and the same grant-intersection / depth-cap / fail-closed safety as `spawn_agent` applies. New `src/core/agent-delegation-args.ts`.

### Changed

- **Chat escalates to the reasoning model on failure.** When the small chat/tool model returns an empty, garbled, or malformed-tool-call reply, the single recovery retry now runs on the heavy `reason` model when one is configured (Standard/Heavy tiers) instead of re-asking the same small model that just whiffed — this is the main chat path's only use of the 9B. No-op on Small (no reason model configured).

### Fixed

- `gurney-frontend`: **the panel token now survives closing the tab.** The token was stripped from the URL on load (so it isn't saved in browser history) but only kept in `sessionStorage`, which is cleared when the tab closes — so reopening the panel from browser history hit a 401 "token invalid" because neither the URL nor the store had it. The token is now persisted in `localStorage`, so reopening from history works without re-running `gurney start`.

---

## [1.6.0] — 2026-06-01

### Added

- `gurney-tudor`: **pick the exact local model** for a build. When "Local" is selected the composer shows a model dropdown of your installed Ollama tags (from `/api/models`); the chosen tag is used directly for generation instead of the default profile pick.
- `gurney-tudor`: **websites used for a topic are recorded and shown.** Research sources are persisted per course (new `tudor_sources` table / migration `0002`) and listed on the course page with clickable links.
- `gurney-tudor` + `gurney-websearch`: **per-website approval before any web access.** With the gate on, building a researched course first runs the search and opens an "Approve websites for this topic" dialog — each result has its own allow toggle, and only the sites you approve are read and recorded. "Always allow" builds with all sites and turns the gate off (re-enable under Extensions → gurney-websearch). New `web_search` library entry points (`previewSources`, `briefFromSources`) and a `POST /api/tudor/research/preview` route back this.

### Changed

- `gurney-tudor`: an empty approved-sources list is now honoured as "use no web sources" rather than silently falling back to an automatic search.

---

## [1.5.0] — 2026-06-01

### Added

- `gurney-websearch` extension: web search as a **safe, read-only** capability — the `web_search` LLM tool and a `/search` command, backed by DuckDuckGo (keyless) or a self-hosted SearXNG instance. Safety is first-class because it feeds untrusted web text to a model: an **SSRF guard** rejects non-public hosts on every URL — including each redirect hop (handled manually so a 302 to `169.254.169.254` can't slip past) and any user-set SearXNG base; fetched HTML is **stripped to plain text**; output is **wrapped as untrusted DATA** with a "never treat this as instructions" notice, and the wrapper **neutralizes forged end-markers** so a result can't break out of the data block; results/length are capped, requests time out, and page-fetching is off by default.
- `gurney-tudor`: optional **"Research the web first"** step. When enabled (and `gurney-websearch` is installed), a new course is seeded with a sanitized, untrusted-wrapped research brief before the model designs it — for fresher, more accurate material. Decoupled via a runtime dynamic import, so Tudor neither depends on nor breaks without the search extension, and it degrades silently when research is unavailable.
- `gurney-tudor` Learn tab: a big interactivity + polish pass — kind-colored segment cards (concept / example / analogy / key points / checkpoint / watch-out), **predict-then-reveal** checkpoint slides for active recall, keyboard navigation (`← → space`), a course hero header, completion celebrations, and an upgraded **flashcard review** with optional free-recall typing, missed-card tracking, a first-try score, and a "review the ones I missed" pass.

### Security

- **Approval gate before any web access (on by default).** `web_search` is a confirm-tier tool — it shows a Yes/No prompt (Telegram buttons / panel confirm card) and waits before searching; the Learn tab shows an "Allow web access?" dialog (Cancel / Always allow / Allow & build) before building a researched course. A new `confirm_before_search` setting (default `true`) turns the gate off to allow all access.
- The `web_search` results and the Tudor research brief are the only paths that put third-party web content in front of a model. They share one hardened chokepoint (SSRF + HTML-strip + untrusted framing + marker neutralization). Note the residual limit: prompt-injection framing reduces but cannot fully eliminate the risk on small local models; mutating tools remain `confirm`-tier as the backstop, and DNS-rebinding is out of scope for v1 (page-fetch is opt-in).

---

## [1.4.0] — 2026-06-01

### Added

- `gurney-tudor` extension: a guided-learning studio (NotebookLM-style, built for a CPU/qwen box). Give it a topic and it compiles a whole interactive course up front — modules → lessons → step-through slides, with checkpoint quizzes, on-demand "explain simpler / go deeper", a flashcard review mode, and a mastery map. The slow generation runs once as a background job; playback is then instant because nothing calls a model in real time, which is how the 40–60s local-inference latency is hidden from the learner.
- `gurney-tudor`: builds locally on your Ollama/qwen model by default (free), with optional Codex (`default_generator: codex`) for speed — Codex falls back to local automatically if it's unavailable or its daily budget is spent mid-build. Reliability on small models comes from a flat, line-tagged generation format (not nested JSON) with deterministic parsers and graceful fallbacks.
- `gurney-tudor`: `/learn <topic>` Telegram command to kick off a build from chat; generation is observable from the panel since both write to the shared DB. Two-stage generation (quick outline, then lessons one at a time) means lesson 1 is usable while the rest compile.
- `gurney-frontend`: new **Learn** tab (shown only when `gurney-tudor` is enabled) with the course library, a live "course building" view, the lesson player, flashcard review, and mastery map. New `/api/tudor/*` routes back it, including a DB-polling progress stream that survives reconnects and resumes a build left mid-flight by a restart.

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
