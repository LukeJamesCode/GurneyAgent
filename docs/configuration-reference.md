# Configuration Reference

Gurney reads configuration from two sources, in priority order:

1. **Environment variables** — always win; existing deployments that set these don't need to change anything.
2. **`~/.gurney/config.json`** — written by `gurney init`, edited by `gurney config`. Only read when the matching env var is not set.

`~/.gurney/` is controlled by the `GURNEY_HOME` environment variable. All paths below use `~/.gurney/` as shorthand.

---

## Environment variables

| Variable               | Config key equivalent | Default                  | Notes                                                                      |
| ---------------------- | --------------------- | ------------------------ | -------------------------------------------------------------------------- |
| `TELEGRAM_BOT_TOKEN`   | `telegram.token`      | —                        | Bot token from @BotFather. Required.                                       |
| `TELEGRAM_ALLOWED_IDS` | `telegram.allowedIds` | —                        | Comma-separated numeric Telegram user IDs. Required.                       |
| `OLLAMA_URL`           | `ollama.url`          | `http://localhost:11434` | Base URL of the Ollama API.                                                |
| `GURNEY_CHAT_MODEL`    | `models.chat`         | `qwen3.5:0.8b`           | Model tag for the chat profile.                                            |
| `GURNEY_REASON_MODEL`  | `models.reason`       | —                        | Model tag for the reasoning profile. Optional.                             |
| `GURNEY_TOOLS_MODEL`   | `models.tools`        | —                        | Model tag for the tool-use profile. Optional; falls back to `models.chat`. |
| `GURNEY_TIER`          | `tier`                | auto-detected            | Hardware tier hint: `small`, `standard`, or `heavy`. Informational only.   |
| `GURNEY_LOG_LEVEL`     | `logLevel`            | `info`                   | Log verbosity: `debug`, `info`, `warn`, or `error`.                        |
| `GURNEY_HOME`          | —                     | `~/.gurney`              | Root directory for config, DB, logs, and extension state.                  |

### Ollama performance variables

These are read by Ollama directly, not by Gurney. Set them in the environment of the process (or container) that runs Ollama.

| Variable                 | Recommended value   | Notes                                                                                                                 |
| ------------------------ | ------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `OLLAMA_NUM_THREADS`     | Physical core count | `8` on a 5800H, `4` on a Pi 5. Defaults to all logical cores, which includes hyperthreads and can hurt CPU inference. |
| `OLLAMA_FLASH_ATTENTION` | `1`                 | Measurable speedup on qwen3.5 with no quality loss.                                                                   |

### Tuning variables

Advanced knobs for operators. Not required in normal use.

| Variable                      | Default          | Notes                                                                                   |
| ----------------------------- | ---------------- | --------------------------------------------------------------------------------------- |
| `GURNEY_HEAVY_IDLE_MS`        | `300000` (5 min) | Milliseconds of inactivity before a heavy model is proactively evicted.                 |
| `GURNEY_INFERENCE_TIMEOUT_MS` | `120000` (2 min) | Hard deadline for a single LLM call. Trips the circuit breaker on timeout.              |
| `GURNEY_MAX_TOOL_ROUNDS`      | `6`              | Maximum tool-call rounds per user message before the orchestrator forces a final reply. |

---

## `~/.gurney/config.json`

Written with mode `0600` (owner read/write only). JSON format; `version` field is managed automatically.

### Full schema

```json
{
  "version": 3,
  "telegram": {
    "token": "<bot-token>",
    "allowedIds": [123456789]
  },
  "ollama": {
    "url": "http://localhost:11434"
  },
  "models": {
    "chat": "qwen3.5:0.8b",
    "reason": "qwen3.5:9b",
    "tools": "qwen3.5:0.8b"
  },
  "tier": "standard",
  "logLevel": "info"
}
```

### Fields

| Field                 | Type     | Default                    | Notes                                                                                                                                                                                                                                                |
| --------------------- | -------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`             | integer  | `3`                        | Config file version. Managed automatically; do not edit.                                                                                                                                                                                             |
| `telegram.token`      | string   | —                          | Bot token from @BotFather.                                                                                                                                                                                                                           |
| `telegram.allowedIds` | number[] | `[]`                       | Numeric Telegram user IDs permitted to chat with the bot. Any message from an ID not in this list is silently dropped.                                                                                                                               |
| `ollama.url`          | string   | `"http://localhost:11434"` | Base URL for the Ollama REST API.                                                                                                                                                                                                                    |
| `models.chat`         | string   | `"qwen3.5:0.8b"`           | Default chat profile model. Used for every turn unless the orchestrator selects a heavier profile.                                                                                                                                                   |
| `models.reason`       | string   | —                          | Optional reasoning profile model. Used for multi-step or complex tasks. Cold-loaded on demand on Standard tier; warm on Heavy tier.                                                                                                                  |
| `models.tools`        | string   | —                          | Optional tool-use profile model. When set, the orchestrator routes tool-call turns through this model instead of `models.chat`. Useful when you have a small fast chat model and a separate tool-fluent model. Falls back to `models.chat` if unset. |
| `tier`                | string   | auto-detected              | `"small"`, `"standard"`, or `"heavy"`. Informational — used by `gurney status` and `gurney doctor` to surface mismatches, not to gate features.                                                                                                      |
| `logLevel`            | string   | `"info"`                   | Log verbosity: `"debug"`, `"info"`, `"warn"`, `"error"`.                                                                                                                                                                                             |

---

## Extension settings

Extension-owned settings are stored in the `extension_settings` SQLite table, not in `config.json`. They are edited via `gurney config` (which renders each extension's `settings.schema.json`) and via `gurney auth` for credentials.

Each extension's settings are documented in its own README. The general schema format is described in [extension-authoring.md](./extension-authoring.md).

---

## Precedence diagram

```
env var TELEGRAM_BOT_TOKEN
  └─ wins over config.json telegram.token
       └─ wins over DEFAULTS.telegram.token ("")
```

Env vars that aren't set are treated as absent — an empty string `""` is NOT treated as a value and will not override the config file. The merge logic in `src/cli/config-store.ts` uses `.trim()` on every env var before checking.

---

## Files and directories under `~/.gurney/`

| Path                      | Created by                      | Notes                                                                                            |
| ------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------ |
| `config.json`             | `gurney init` / `gurney config` | Core config. Mode 0600.                                                                          |
| `gurney.db`               | `gurney start` (first run)      | SQLite database. All conversation and extension data.                                            |
| `gurney.pid`              | `gurney start --detach`         | PID of the running daemon. Removed on clean shutdown.                                            |
| `log/gurney.log`          | `gurney start --detach`         | Rotating log file. Plain JSON lines.                                                             |
| `extensions/<name>/`      | `gurney ext install`            | User-installed extensions.                                                                       |
| `extension_state/<name>/` | Extension loader                | Per-extension data directory (`host.dataDir`). Extensions own this space; core never touches it. |
