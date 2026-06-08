# 04. Operations and Troubleshooting

This section covers day-to-day operations, including configuration, Telegram commands, troubleshooting common issues, migrating from ATLAS, and internal release processes.

## Configuration Reference

Gurney reads configuration from two sources, in priority order:
1. **Environment variables** — Always win.
2. **`~/.gurney/config.json`** — Written by `gurney init`, edited by `gurney config`.

### Environment Variables
| Variable               | Config key equivalent | Default                  | Notes                                                                      |
| ---------------------- | --------------------- | ------------------------ | -------------------------------------------------------------------------- |
| `TELEGRAM_BOT_TOKEN`   | `telegram.token`      | —                        | Bot token from @BotFather. Required.                                       |
| `TELEGRAM_ALLOWED_IDS` | `telegram.allowedIds` | —                        | Comma-separated numeric Telegram user IDs. Required.                       |
| `OLLAMA_URL`           | `ollama.url`          | `http://localhost:11434` | Base URL of the Ollama API.                                                |
| `GURNEY_CHAT_MODEL`    | `models.chat`         | `qwen3.5:0.8b`           | Model tag for the chat profile.                                            |
| `GURNEY_REASON_MODEL`  | `models.reason`       | —                        | Model tag for the reasoning profile. Optional.                             |
| `GURNEY_TOOLS_MODEL`   | `models.tools`        | —                        | Model tag for the tool-use profile. Optional.                              |
| `GURNEY_LOG_LEVEL`     | `logLevel`            | `info`                   | Log verbosity: `debug`, `info`, `warn`, or `error`.                        |
| `GURNEY_HOME`          | —                     | `~/.gurney`              | Root directory for config, DB, logs, and extension state.                  |
| `GURNEY_FS_ROOT`       | —                     | — (off)                  | Absolute path to a directory to expose read-only via the `read_file` / `list_dir` tools (e.g. a local checkout for a code-review agent). Unset = tools not registered. Access is pinned to this root (no `..`/symlink escape); also visible to the main chat when set. |

## Telegram Command Reference

Core commands are always present. Use `/help` to see the commands currently active.

| Command        | Arguments     | What it does                                                                                              |
| -------------- | ------------- | --------------------------------------------------------------------------------------------------------- |
| `/start`       | —             | Welcome message and quick how-to                                                                          |
| `/help`        | —             | List all installed commands grouped by extension                                                          |
| `/newchat`     | —             | Reset conversation context. Starts a new conversation.                                                    |
| `/stop`        | —             | Cancel an in-flight reply. Sends an abort signal to the active LLM call.                                  |
| `/model`       | —             | Show the active model profiles                                                                            |
| `/status`      | —             | Bot uptime, Ollama health, installed extensions, job queue depth                                          |
| `/lasterror`   | —             | Show the last orchestrator error for this chat                                                            |
| `/extensions`  | —             | List installed extensions and their enabled/disabled state                                                |
| `/devmode`     | `on` \| `off` | Append per-reply diagnostics (model, token counts, elapsed time)                                          |
| `/setup`       | —             | Owner-only setup wizard in Telegram: token, allowlist, Ollama URL, hardware tier, auth, settings.         |
| `/fresh`       | —             | Owner-only destructive fresh rebuild from Telegram: wipes `~/.gurney`, then runs the setup wizard.        |

> [!NOTE]
> Extensions register their own slash commands which will dynamically appear in Telegram.

---

## Troubleshooting

Run `gurney doctor` first — it catches most setup issues automatically.

### Common Issues
- **`home` check failed**: You haven't run `gurney init` yet.
- **`ram` check failed**: The bot is on a device with <4 GB RAM. Use a smaller model or add swap.
- **`telegram` check failed**: The bot token is invalid. Get a new one from @BotFather and update it via `gurney config`.
- **Bot doesn't respond to messages**:
  - Run `gurney status` to see if it's running.
  - Verify your Telegram ID is in `telegram.allowedIds`.
  - Use `/lasterror` in chat to see the last failure.
- **"I'm having trouble connecting to my language model"**: Ollama has stopped responding. Check `curl http://localhost:11434/api/tags`. The circuit breaker will recover once Ollama is healthy.
- **Replies are very slow (>30s)**: It's likely a cold-load from disk. Subsequent replies will be faster. Make sure `OLLAMA_NUM_THREADS` is set to your physical core count.

---

## Migrating from ATLAS v2

If you are migrating from Gurney's predecessor (ATLAS v2), you can use the built-in migration tool to import conversations and messages.

```sh
node tools/migrate-from-atlas/index.js \
  --source /path/to/atlas.db \
  --target ~/.gurney/gurney.db
```

ATLAS skills are replaced by Gurney extensions. You will need to re-authorize (e.g. `gurney auth gurney-everyday-assistant`) since OAuth tokens use different scopes in Gurney. Note that Gurney has no Web UI.

---

## Internal: Public Release Checklist (1.0)

For maintainers publishing a new version of Gurney, ensure these criteria are met before tagging:
- `npm run lint`, `format:check`, `typecheck`, and `test` must pass on Node 20 and 22.
- E2E tests: `gurney init` against real Ollama/Telegram; `gurney doctor` is green.
- `docker compose config` is clean.
- Hardware tier verification: Pi 4 soak test (24h light traffic, no OOM).
- Telemetry/Performance: Ensure speculative decoding benchmarks (if any) are documented. Heavy-model eviction should be observed.
- Migrations: `tools/migrate-from-atlas/` works without data loss. Numbered migrations checksum cleanly.
- Security: `gurney config` masks secrets. Logger redacts secrets in error paths. No unknown outbound calls.
