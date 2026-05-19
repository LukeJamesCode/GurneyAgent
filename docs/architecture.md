# Architecture

How Gurney works internally. Read this before touching `src/core/`.

---

## Overview

```
┌────────────────────────────────────────────────────────────┐
│                     Gurney CORE                            │
│  ┌──────────────┐  ┌────────────────┐  ┌──────────────┐   │
│  │  Telegram    │  │  Orchestrator  │  │  Extension   │   │
│  │  adapter     │──│  + queues      │──│  loader      │   │
│  └──────────────┘  └───────┬────────┘  └──────┬───────┘   │
│                            │                  │           │
│                  ┌─────────▼─────────┐  ┌─────▼──────┐   │
│                  │  Context manager  │  │ Tool engine │   │
│                  └─────────┬─────────┘  └─────┬──────┘   │
│                            │                  │           │
│                  ┌─────────▼─────────┐        │           │
│                  │  Model interface  │◄────────┘           │
│                  │  (Ollama HTTP)    │                     │
│                  └─────────┬─────────┘                     │
│                            │                               │
│  ┌──────────────┐  ┌───────▼────────┐                     │
│  │  SQLite      │  │  Scheduler     │                     │
│  │  (core data) │  │  (cron + nudge)│                     │
│  └──────────────┘  └────────────────┘                     │
└────────────────────────────┬───────────────────────────────┘
                             │ extension API (Host)
        ┌────────────────────┼────────────────────┐
   ┌────▼─────┐         ┌────▼──────┐        ┌────▼─────┐
   │ gurney-  │         │ gurney-   │        │ gurney-  │
   │ google-  │         │ reminders │        │ memgraph │
   │ calendar │         │           │        │          │
   └──────────┘         └───────────┘        └──────────┘
```

Gurney is a single Node.js process. There is no HTTP server, no frontend, no IPC bus. Everything is in-process: two work queues, a shared SQLite connection, and a set of registries that extensions populate at load time.

---

## Two-queue orchestrator (`src/core/orchestrator.ts`)

The orchestrator is the central pipeline. It owns two independent queues:

### User-facing queue (per chat)

Each Telegram chat gets its own FIFO queue. Messages from the same chat are processed one at a time so the model never sees interleaved context. This makes `/stop` (abort a reply mid-stream) reliable — the in-flight request holds an `AbortController` the Telegram adapter can signal.

**Per-message pipeline:**

1. Load conversation history from SQLite
2. Build context (via context manager)
3. Call the LLM (chat profile)
4. If the model returns tool calls: execute them (via tool engine), append results, loop back to 3 — up to `GURNEY_MAX_TOOL_ROUNDS` (default 6)
5. Stream the final reply back to Telegram in chunks
6. Persist the new messages to SQLite
7. Enqueue background work (memory extraction, summary update) to the background queue

### Background queue (shared)

A single worker processes background jobs: memory extraction, session summary compression, any work an extension enqueues via `host.scheduler`. The user-facing queue never blocks on this — post-processing happens after the reply has shipped.

---

## Context manager (`src/core/context.ts`)

Assembles the prompt sent to the model. Critically, **the assembly order is always the same**:

```
system → tools → memory → session → history
```

This deterministic prefix is what lets Ollama reuse its KV cache slot across turns. If the prefix changes (different tool list, different memory, different system prompt), Ollama must reprocess from the point of divergence. Gurney keeps the prefix stable by:

- Fixing the system prompt order (extensions contribute fragments appended in registration order, which doesn't change while the bot is running)
- Fixing the tool schema order (same)
- Caching memory results per-conversation and only re-fetching on a topic shift
- Keeping session memory compact (background summarisation, not in-turn updates)

The context manager also token-budgets. Each profile has a max token limit; the manager trims history from the oldest end to stay inside it, preserving the system prefix and the last N turns intact.

---

## Model interface (`src/core/llm.ts`)

Wraps the Ollama HTTP API. Callers ask for a profile (`chat`, `reason`, `tools`) or a literal model tag; the interface resolves it to the right model and manages:

### Profile routing

| Profile  | When used                                                                                       |
| -------- | ----------------------------------------------------------------------------------------------- |
| `chat`   | Normal conversation turns                                                                       |
| `reason` | Multi-step or complex tasks (when the model decides it needs deeper reasoning)                  |
| `tools`  | Any turn where tool schemas are attached. Falls back to `chat` if no tools model is configured. |

### Heavy-model eviction

Only one 7–9B model is kept resident in Ollama at a time on Standard and Heavy tiers. When a different heavy profile is requested, the current one is unloaded (`keep_alive=0`) before the new one loads. An idle sweep (`GURNEY_HEAVY_IDLE_MS`, default 5 min) proactively evicts a heavy model that hasn't been used, so a single reasoning turn doesn't pin RAM until the next restart.

### Circuit breaker

After N consecutive failures the breaker opens. While open, calls fail fast with a typed error rather than waiting for the full timeout. The half-open phase requires a configurable number of consecutive successes before fully closing — single-probe re-opens were observed to chatter against Ollama's first cold-load on a Pi 5, so we require multiple clean probes.

### Streaming

`llm.chat()` is an async generator that yields `ChatChunk` deltas. The orchestrator forwards these to Telegram as they arrive, giving the user a streaming reply rather than a single delayed message.

---

## Tool engine (`src/core/tools.ts`)

Owns the registry of tool handlers. Extensions populate it via `host.tools.register(...)` at load time.

### Permission tiers

| Tier      | When it runs                                                                              |
| --------- | ----------------------------------------------------------------------------------------- |
| `auto`    | Runs without user confirmation. Use for read-only or low-stakes tools.                    |
| `confirm` | Sends a Telegram confirmation prompt before running. Use for anything that mutates state. |
| `owner`   | Admin-only. Runs only for user IDs that have the owner flag.                              |

### Execution

When the model returns a `tool_calls` block, the orchestrator calls `tools.execute(call, ctx)`. The engine:

1. Looks up the handler by name
2. Validates the arguments against the handler's JSON Schema (unless `skipValidation: true`)
3. Enforces the permission tier
4. Runs the handler with a per-call deadline (`DEFAULT_TOOL_TIMEOUT_MS` = 15s, overridable per-tool)
5. Fires any registered `afterExecute` listeners (used by extensions to bust fast-cache entries on writes)

### `selfReplying` tools

A tool with `selfReplying: true` bypasses the follow-up LLM call. Its output goes directly to the user as the reply. Use this for action tools whose response is the user-facing confirmation — a second LLM call to paraphrase "Deleted." wastes the same CPU time as the action itself.

### Intent-based pruning

Extensions can declare an `intent_pattern` regex in `manifest.json`. The orchestrator tests the user's message against all patterns and only includes tool schemas from matching extensions in the per-turn manifest. This keeps the LLM's tool list short (and the prompt prefix stable) when only one or two extensions are relevant.

---

## Extension loader (`src/core/extensions.ts`)

Discovers, validates, and loads extensions. Searches two roots: `<repo>/extensions/` (bundled) and `~/.gurney/extensions/` (user-installed).

### Load lifecycle per extension

1. **Discover** — find `<root>/<name>/manifest.json`
2. **Validate** — parse manifest, check name + semver range
3. **Migrate** — run `migrations/*.sql` against the shared DB using a private `_ext_<name>_migrations` table
4. **Settings** — load `settings.schema.json` defaults, merge saved values from `extension_settings`
5. **Prompt** — load `prompt.md` if present
6. **Import** — dynamic-import each entrypoint and call `register(host)`
7. **Live** — extension's tools/commands/jobs are visible

### Partial-load safety

Every `host.*` call during load records a disposer on a staging record. If any entrypoint throws mid-load, disposers run in LIFO order before bailing. This ensures a half-loaded extension can't leave stale Telegram commands, intercepts, prompt fragments, or scheduler jobs behind.

### Hot-reload

A filesystem watch (`chokidar`-style) monitors both extension roots. When a file inside an extension folder changes (mtime update):

1. The old extension is unloaded: its disposers run
2. The module cache entry is busted (new import URL with `?v=<mtime>`)
3. The extension is re-loaded from scratch

`gurney ext reload <name>` touches the folder's mtime to trigger this without editing any source file.

---

## Scheduler (`src/core/scheduler.ts`)

A cron tick that fires every minute. Extensions register jobs via `host.scheduler.cron(key, expression, handler)`.

### Rate limiting and dedup

When multiple extensions fire jobs in the same minute, the nudge dispatcher enforces cross-extension rate limits so the user doesn't receive three simultaneous pings. Dedup keys (per extension, per job) persist in the `nudge_log` table so they survive a process restart.

### Quiet hours

`chat_prefs` stores per-chat quiet windows (minute-of-day). Nudges to a quiet chat are dropped. One-shot snooze (`paused_until_ms`) is also available.

### Followups

A separate sweep handles followups — one-shot future messages the model commits to send via the core `schedule_followup` tool ("remind me to take the chicken out at 5"). These are distinct from extension cron jobs and from reminders; they're model-authored one-shots.

---

## SQLite and migrations (`src/storage/`)

A single `better-sqlite3` connection shared across core and all extensions. Synchronous API; fits the single-process model cleanly.

### Numbered migrations

Core migrations live in `src/storage/migrations/NNNN_name.sql`. Applied migrations are recorded in `_migrations` with a checksum. Rules:

- **Never edit an applied migration.** Write a new file.
- **Never use `addColumnIfMissing`.** New columns get a new numbered file.
- The `_migrations` checksum check in `gurney doctor` catches modified-after-applied files.

Extensions get their own `_ext_<name>_migrations` table. Per-extension migration files live in `extensions/<name>/migrations/`. They follow the same rules.

---

## Telegram adapter (`src/adapters/telegram.ts`)

Uses grammY in long-poll mode (no webhook, no open port). Responsibilities:

- Allowlist enforcement: messages from non-allowed user IDs are silently dropped
- Per-chat queue dispatch: routes each message to the orchestrator's user-facing queue for that chat
- Extension command dispatch: looks up the command handler table built at load time
- Extension intercept chain: runs registered intercepts before the orchestrator for messages that aren't slash commands
- Streaming: forwards `ReplyChunk` deltas from the orchestrator back to Telegram as edits to a "typing..." placeholder message
- Nudge dispatch: the scheduler calls `sendMessage(chatId, text)` for proactive nudges

---

## Logger and secret redaction (`src/util/log.ts`, `src/util/redact.ts`)

Structured JSON log lines. The redactor runs on every log call and scrubs values that look like secrets (bot tokens, OAuth tokens, API keys) before they hit stdout or the log file. Extensions receive a namespaced child logger via `host.log` — same redaction guarantees, prefixed with the extension name.
