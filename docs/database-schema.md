# Database Schema

Gurney uses a single SQLite file at `~/.gurney/gurney.db`. All core tables and per-extension tables live here, separated by ownership convention.

---

## Migration system

Applied migrations are tracked in `_migrations`:

| Column       | Type       | Notes                                                                   |
| ------------ | ---------- | ----------------------------------------------------------------------- |
| `version`    | INTEGER PK | The numeric prefix of the migration file (e.g. `1` for `0001_init.sql`) |
| `name`       | TEXT       | Filename without the version prefix                                     |
| `checksum`   | TEXT       | SHA-256 of the file contents at apply time                              |
| `applied_at` | INTEGER    | Unix timestamp (ms)                                                     |

`gurney doctor` compares on-disk checksums against this table and fails if a file was modified after it was applied. **Never edit an applied migration** — write a new numbered file instead.

Per-extension migrations use `_ext_<name>_migrations` with the same schema, owned by each extension.

---

## Core tables

### `conversations`

One row per conversation (a `/newchat` boundary).

| Column             | Type       | Notes                                                    |
| ------------------ | ---------- | -------------------------------------------------------- |
| `id`               | INTEGER PK | Auto-increment                                           |
| `telegram_chat_id` | INTEGER    | The Telegram chat this conversation belongs to           |
| `started_at`       | INTEGER    | Unix timestamp (ms)                                      |
| `ended_at`         | INTEGER    | NULL while the conversation is active; set on `/newchat` |

Index: `(telegram_chat_id, ended_at)` — used to find the open conversation for a chat.

---

### `messages`

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

Index: `(conversation_id, id)` — used to load history in order.

---

### `telegram_chats`

Per-chat state: current open conversation, devmode flag, last error.

| Column                    | Type       | Notes                                                                             |
| ------------------------- | ---------- | --------------------------------------------------------------------------------- |
| `chat_id`                 | INTEGER PK | Telegram chat ID                                                                  |
| `user_id`                 | INTEGER    | Telegram user ID of the chat owner                                                |
| `current_conversation_id` | INTEGER FK | References `conversations.id`; set to NULL on `/newchat` before opening a new one |
| `devmode`                 | INTEGER    | `0` or `1`; toggled by `/devmode on/off`                                          |
| `last_error`              | TEXT       | Last orchestrator error string for this chat; surfaced by `/lasterror`            |
| `last_seen_at`            | INTEGER    | Unix timestamp (ms) of the most recent message                                    |

---

## Extension-managed tables

### `extension_state`

Which extensions are installed and their enabled state.

| Column           | Type    | Notes                                       |
| ---------------- | ------- | ------------------------------------------- |
| `name`           | TEXT PK | Extension name (matches folder name)        |
| `version`        | TEXT    | Semver string from `manifest.json`          |
| `enabled`        | INTEGER | `1` enabled, `0` disabled                   |
| `installed_at`   | INTEGER | Unix timestamp (ms)                         |
| `last_loaded_at` | INTEGER | Unix timestamp (ms) of last successful load |

---

### `extension_settings`

Key/value store for all extension configuration.

| Column       | Type    | Notes                                     |
| ------------ | ------- | ----------------------------------------- |
| `extension`  | TEXT    | Extension name                            |
| `key`        | TEXT    | Setting key (from `settings.schema.json`) |
| `value`      | TEXT    | JSON-encoded value                        |
| `updated_at` | INTEGER | Unix timestamp (ms)                       |

Primary key is `(extension, key)`. Secrets are stored as plaintext — the file is at `~/.gurney/gurney.db` (mode `0600`). Access controls are OS-level.

---

## Proactive / nudge tables

### `chat_prefs`

Per-chat proactive preferences.

| Column               | Type       | Notes                                                                                   |
| -------------------- | ---------- | --------------------------------------------------------------------------------------- |
| `chat_id`            | INTEGER PK | Telegram chat ID                                                                        |
| `quiet_start_minute` | INTEGER    | Start of quiet window, minute-of-day [0–1439]. NULL = no window.                        |
| `quiet_end_minute`   | INTEGER    | End of quiet window, minute-of-day [0–1439]. `start > end` means window wraps midnight. |
| `paused_until_ms`    | INTEGER    | One-shot snooze: suppress nudges until this timestamp. NULL = not snoozed.              |
| `updated_at`         | INTEGER    | Unix timestamp (ms)                                                                     |

---

### `nudge_log`

Append-only record of every nudge dispatched. Used for cross-extension rate-limiting and dedup.

| Column      | Type       | Notes                                                                                  |
| ----------- | ---------- | -------------------------------------------------------------------------------------- |
| `id`        | INTEGER PK | Auto-increment                                                                         |
| `chat_id`   | INTEGER    | Telegram chat that received the nudge                                                  |
| `extension` | TEXT       | Extension that generated it                                                            |
| `job`       | TEXT       | Job key that generated it                                                              |
| `key`       | TEXT       | Optional dedup key (e.g. event ID). Scheduler skips if the same key was sent recently. |
| `sent_at`   | INTEGER    | Unix timestamp (ms)                                                                    |

Indexes: `(chat_id, sent_at)` for rate-limit lookups; `(key, sent_at)` for dedup lookups.

---

### `followups`

One-shot future messages the model commits to send via the `schedule_followup` core tool.

| Column       | Type       | Notes                                             |
| ------------ | ---------- | ------------------------------------------------- |
| `id`         | INTEGER PK | Auto-increment                                    |
| `chat_id`    | INTEGER    | Telegram chat to notify                           |
| `due_at`     | INTEGER    | Unix timestamp (ms) when the followup should fire |
| `topic`      | TEXT       | The message to send                               |
| `created_at` | INTEGER    | Unix timestamp (ms)                               |
| `fired_at`   | INTEGER    | Set on dispatch; NULL means pending               |

Index: `(fired_at, due_at)` — scheduler sweeps for rows where `fired_at IS NULL AND due_at <= now`.

---

## Per-extension tables

Each extension that declares `migrations/*.sql` gets its own tables. Naming conventions are up to the extension. The only constraint: the extension's migration table is `_ext_<name>_migrations` (managed by core).

### `gurney-everyday-assistant`: `calendar_nudges_sent`

Dedup table for the event-reminder sweep.

| Column          | Notes                    |
| --------------- | ------------------------ |
| `event_id`      | Google Calendar event ID |
| `nudge_sent_at` | Unix timestamp (ms)      |

### `gurney-everyday-assistant`: `reminders`

| Column       | Notes                               |
| ------------ | ----------------------------------- |
| `id`         | Auto-increment PK                   |
| `chat_id`    | Telegram chat                       |
| `due_at`     | Unix timestamp (ms)                 |
| `message`    | Reminder text                       |
| `created_at` | Unix timestamp (ms)                 |
| `fired_at`   | Set when dispatched; NULL = pending |

### `gurney-tts`: `voice_prefs`

Per-chat voice preference.

| Column       | Notes                 |
| ------------ | --------------------- |
| `chat_id`    | Telegram chat ID (PK) |
| `enabled`    | `1` voice on, `0` off |
| `updated_at` | Unix timestamp (ms)   |

### `gurney-memgraph`: `memgraph_sync_state` _(planned, v1.4)_

`gurney-memgraph` is not in the 1.0 bundle; it's slated to return in v1.4 — see the [Roadmap](../README.md#roadmap). The schema below documents the 0.x shape for reference; the final schema will be confirmed alongside the v1.4 release.

| Column            | Notes                                       |
| ----------------- | ------------------------------------------- |
| `conversation_id` | Conversation already sent to the bridge PK  |
| `last_message_id` | Last message ID synced for the conversation |
| `last_synced_at`  | Unix timestamp (ms)                         |
