# 02. Repository and Architecture

This guide explains how Gurney works internally, detailing its architecture and database schema. Read this before touching `src/core/`.

## Architecture Overview

Gurney is a single Node.js process. There is no HTTP server, no frontend, no IPC bus. Everything is in-process: two work queues, a shared SQLite connection, and a set of registries that extensions populate at load time.

```text
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
   │ everyday-│         │ tts       │        │ routines │
   │ assistant│         │           │        │          │
   └──────────┘         └───────────┘        └──────────┘
```

### Two-queue Orchestrator (`src/core/orchestrator.ts`)
The orchestrator owns two independent queues:
- **User-facing queue (per chat):** Messages from the same chat are processed one at a time so the model never sees interleaved context.
- **Background queue (shared):** A single worker processes memory extraction, session summary compression, and extension background jobs.

### Context Manager (`src/core/context.ts`)
Assembles the prompt sent to the model. **The assembly order is always the same:** `system → tools → memory → session → history`.
This deterministic prefix allows Ollama to reuse its KV cache slot across turns, massively speeding up multi-turn latency.

### Model Interface (`src/core/llm.ts`)
Wraps the Ollama HTTP API and manages Profile routing (`chat`, `reason`, `tools`), heavy-model eviction, the circuit breaker (for quick failures during Ollama downtime), and streaming via async generators.

The one model quirk core handles is **thinking suppression**: reasoning models (qwen3, Gemma 4) emit `<think>` blocks that waste CPU tokens, so Gurney sends Ollama `think: false` and prepends `/no_think` for them. A model that has no thinking mode (Gemma 2/3) must *not* be sent the `think` parameter — Ollama errors — so suppression is skipped for it even when a profile's `thinkMode` is `off`.

To decide which is which, the LLM layer probes Ollama's `/api/show` `capabilities` list per model (cached for the process). When the probe can't answer — pre-capabilities Ollama, a model that isn't pulled, a network error — it falls back to a tag heuristic in `src/core/model-family.ts` (which knows qwen3 and Gemma 4+ reason, Gemma 2/3 don't, and leaves unknown tags to honour an explicit `thinkMode`).

### Tool Engine (`src/core/tools.ts`)
Owns the registry of tool handlers.
- **Permission tiers:** `auto` (runs silently), `confirm` (Telegram prompt), `owner` (admin-only).
- **Intent-based pruning:** Extensions can declare an `intent_pattern` regex. If a user's message matches the regex, that extension's tools are injected. If not, they are omitted, keeping the LLM's tool list short and the prompt prefix stable.

---

## Database Schema and Migrations (`src/storage/`)

Gurney uses a single SQLite file at `~/.gurney/gurney.db`.

### Migration System
Applied migrations are tracked in `_migrations`. `gurney doctor` compares on-disk checksums against this table. **Never edit an applied migration** — write a new numbered file instead. Never use `addColumnIfMissing`.

Per-extension migrations live in `extensions/<name>/migrations/` and use `_ext_<name>_migrations`.

### Core Tables

#### `conversations`
One row per conversation (a `/newchat` boundary).
| Column             | Type       | Notes                                                    |
| ------------------ | ---------- | -------------------------------------------------------- |
| `id`               | INTEGER PK | Auto-increment                                           |
| `telegram_chat_id` | INTEGER    | The Telegram chat this conversation belongs to           |
| `started_at`       | INTEGER    | Unix timestamp (ms)                                      |
| `ended_at`         | INTEGER    | NULL while the conversation is active; set on `/newchat` |

#### `messages`
Every message in every conversation.
| Column            | Type       | Notes                                                           |
| ----------------- | ---------- | --------------------------------------------------------------- |
| `id`              | INTEGER PK | Auto-increment                                                  |
| `conversation_id` | INTEGER FK | References `conversations.id`; cascades on delete               |
| `role`            | TEXT       | `system`, `user`, `assistant`, or `tool`                        |
| `content`         | TEXT       | Message text                                                    |
| `tool_call_id`    | TEXT       | Set on `tool` role rows; matches the model's tool call ID       |
| `tool_name`       | TEXT       | Set on `tool` role rows; which tool was called                  |
| `tokens`          | INTEGER    | Token count for this message (filled in by the model interface) |
| `created_at`      | INTEGER    | Unix timestamp (ms)                                             |

#### `telegram_chats`
Per-chat state: current open conversation, devmode flag, last error.

---

### Extension-managed Tables

#### `extension_state`
Tracks installed extensions and their active state.

#### `extension_settings`
Key/value store for all extension configuration.
| Column       | Type    | Notes                                     |
| ------------ | ------- | ----------------------------------------- |
| `extension`  | TEXT    | Extension name                            |
| `key`        | TEXT    | Setting key (from `settings.schema.json`) |
| `value`      | TEXT    | JSON-encoded value                        |

Primary key is `(extension, key)`. Secrets are stored as plaintext — protected by OS-level permissions at `~/.gurney`.

---

### Proactive / Nudge Tables

#### `chat_prefs`
Per-chat proactive preferences (quiet hours and snoozing).
| Column               | Type       | Notes                                                            |
| -------------------- | ---------- | ---------------------------------------------------------------- |
| `chat_id`            | INTEGER PK | Telegram chat ID                                                 |
| `quiet_start_minute` | INTEGER    | Start of quiet window, minute-of-day                             |
| `quiet_end_minute`   | INTEGER    | End of quiet window                                              |
| `paused_until_ms`    | INTEGER    | One-shot snooze: suppress nudges until this timestamp            |

#### `nudge_log`
Append-only record of every nudge dispatched, used for cross-extension rate-limiting and deduplication.

#### `followups`
One-shot future messages the model commits to send via the `schedule_followup` core tool.

---

## Adapter and Utilities

### Telegram Adapter (`src/adapters/telegram.ts`)
Uses grammY in long-poll mode (no webhook, no open port). Handles allowlist enforcement, per-chat queue dispatch, extension intercept chains, and streams `ReplyChunk` deltas as live edits.

### Logger and Secret Redaction (`src/util/log.ts`)
Structured JSON log lines. The redactor runs on every log call and scrubs values that look like secrets (tokens, API keys) before they hit stdout or the log file.
