# CLI Reference

Complete reference for every `gurney` subcommand and flag.

Exit codes: `0` on success, `1` on error, `130` when the user cancels an interactive prompt (Ctrl-C).

---

## `gurney init`

First-run wizard. Walks through Telegram token, allowlist, Ollama URL, model selection, and hardware tier. Writes `~/.gurney/config.json` with mode `0600`.

```sh
gurney init
```

Re-running `init` is safe: your existing values load as defaults and you only need to change what's different. The wizard steps are:

1. Telegram bot token (validated live against `getMe`)
2. Allowed Telegram user IDs (comma-separated numeric IDs)
3. Ollama URL (probed live; default `http://localhost:11434`)
4. Chat model (pick from live model list or enter a tag manually)
5. Reasoning model (optional heavier model; choose `skip` on small devices)
6. Hardware tier (auto-suggested from total RAM; override freely)

Config is written only after every step completes. Cancelling mid-wizard leaves the previous config intact.

---

## `gurney config`

Interactive TUI for all settings: core knobs plus every installed extension's `settings.schema.json`. Changes persist to `~/.gurney/config.json` (core) and the `extension_settings` SQLite table (extension-owned).

```sh
gurney config
```

Navigate with arrow keys. Secret fields (`"secret": true` in the schema) are masked in the prompt and stored obfuscated. Changes take effect immediately on a running bot — the bot re-reads settings on the next relevant operation.

---

## `gurney auth`

Run an extension's auth flow from the terminal.

```sh
gurney auth <extension-name>
```

Imports the extension's `auth.ts`, runs its declared flow, and writes the returned values into `extension_settings`. For OAuth extensions, a local callback server is opened on a random free port — you don't need to copy authorization codes by hand.

**Examples:**

```sh
gurney auth gurney-everyday-assistant
```

---

## `gurney models`

Re-run only the model-picker step from `gurney init`. Use this when you pull new Ollama models and want to switch profiles without going through the full wizard.

```sh
gurney models
```

Lets you pick or change: chat model, reasoning model (optional), and tools model (optional). All core model profiles use Ollama.

---

## `gurney start`

Run the bot. Wires up (in order): logger, SQLite + migrations, Ollama client, tool registry, scheduler, extension loader, orchestrator, Telegram long-poll.

```sh
gurney start              # foreground — logs to stdout
gurney start --detach     # background daemon — logs to ~/.gurney/log/gurney.log
```

**Flags:**

| Flag       | Description                                                                                |
| ---------- | ------------------------------------------------------------------------------------------ |
| `--detach` | Spawn a background process, write its PID to `~/.gurney/gurney.pid`, and exit immediately. |

Gurney refuses to double-start: if a PID file points at a live process, `start` exits with an error. Run `gurney stop` first.

---

## `gurney stop`

Stop a running daemon.

```sh
gurney stop
```

Sends `SIGTERM` to the PID in `~/.gurney/gurney.pid`. The process drains its queues, shuts down the scheduler and extension loader, and exits cleanly. No-ops if no PID file exists or the process is already gone.

---

## `gurney logs`

Stream the log file at `~/.gurney/log/gurney.log`.

```sh
gurney logs             # print full log file
gurney logs --follow    # tail -f (Ctrl-C to stop)
gurney logs -f          # shorthand
```

**Flags:**

| Flag             | Description                           |
| ---------------- | ------------------------------------- |
| `-f`, `--follow` | Follow new log lines, like `tail -f`. |

Only meaningful when the bot was started with `--detach`. In foreground mode logs go to stdout directly.

---

## `gurney status`

One-shot health summary of a running bot.

```sh
gurney status          # two-column text output
gurney status --json   # machine-readable JSON
```

**Flags:**

| Flag     | Description                                                       |
| -------- | ----------------------------------------------------------------- |
| `--json` | Emit a single JSON object instead of the default two-column text. |

**Example output:**

```
home         /home/pi/.gurney
running      yes (pid 12345)
ollama       ok @ http://localhost:11434 (3 models)
chat model   qwen3.5:0.8b
reason model qwen3.5:9b
allowlist    123456789
extensions   gurney-everyday-assistant
job queue    0 pending
```

---

## `gurney doctor`

Full preflight diagnostics. Runs all checks in parallel and prints a `✓` / `✗` summary.

```sh
gurney doctor
```

Exits `0` if all checks pass, `1` if any fail.

**Checks:**

| Check        | What it verifies                                                                    |
| ------------ | ----------------------------------------------------------------------------------- |
| `home`       | `~/.gurney/` exists; if not, prompts `run 'gurney init'`                            |
| `config`     | All required keys are set: token, allowedIds, ollama URL, chat model                |
| `ram`        | Total system RAM ≥ 4 GB                                                             |
| `disk`       | At least 1 GB free on the partition holding `~/.gurney/`                            |
| `extensions` | Every folder under the extension search roots has a valid `manifest.json`           |
| `migrations` | `_migrations` table is present; no pending or checksum-mismatched files             |
| `env`        | No deprecated or unrecognised `GURNEY_*` / `TELEGRAM_*` / `OLLAMA_*` env vars       |
| `ports`      | Ollama's configured port is held by a listening process (skipped for remote URLs)   |
| `telegram`   | Bot token passes a live `getMe` call                                                |
| `ollama`     | Ollama URL is reachable and all configured models (chat, reason, tools) are present |

---

## `gurney update`

Pull latest code, reinstall dependencies, and rebuild.

```sh
gurney update
```

Runs `git pull`, `npm install`, and `npm run build` in sequence. Does not restart a running daemon — run `gurney stop && gurney start --detach` after updating.

---

## `gurney fresh`

Wipe all Gurney data, update code, and re-run the setup wizard.

```sh
gurney fresh
```

Deletes `~/.gurney/` (config, DB, logs, extension state), pulls latest code, reinstalls deps, rebuilds, and launches `gurney init`. Use this to start completely fresh or to recover from a broken state. **Irreversible — back up `~/.gurney/gurney.db` first if you care about conversation history.**

---

## `gurney ext list`

List all installed extensions and their enabled/disabled state.

```sh
gurney ext list
```

Shows extensions from both `<repo>/extensions/` (bundled) and `~/.gurney/extensions/` (user-installed), version, and whether each is currently enabled.

---

## `gurney ext install`

Install an extension from a local path, git URL, or repo-bundled name.

```sh
gurney ext install <source>
```

**Install sources (tried in priority order):**

| Source            | Example                                                           |
| ----------------- | ----------------------------------------------------------------- |
| Local path        | `gurney ext install ./my-extension`                               |
| Git URL           | `gurney ext install https://github.com/user/gurney-something.git` |
| Repo-bundled name | `gurney ext install gurney-everyday-assistant`                    |

Bundled name resolution uses `extensions/registry.json` (or the URL in `GURNEY_REGISTRY_URL`). Installed extensions land in `~/.gurney/extensions/<name>/`.

---

## `gurney ext enable`

Enable a disabled extension.

```sh
gurney ext enable <name>
```

Flips the `enabled` flag in `extension_state`. Takes effect on the next hot-reload or bot restart.

---

## `gurney ext disable`

Disable an extension without removing it.

```sh
gurney ext disable <name>
```

Stops the extension from loading on next restart or reload. Files and settings are preserved.

---

## `gurney ext uninstall`

Remove an extension.

```sh
gurney ext uninstall <name>             # remove folder; keep settings in DB
gurney ext uninstall <name> --purge     # remove folder + drop settings from DB
```

**Flags:**

| Flag      | Description                                                                                                                                                              |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--purge` | Also drop the extension's rows from `extension_state` and `extension_settings`. Per-extension SQLite tables (created by the extension's `migrations/`) are also dropped. |

Only works for extensions installed under `~/.gurney/extensions/`. Bundled extensions (in `<repo>/extensions/`) cannot be uninstalled this way — disable them instead.

---

## `gurney ext reload`

Touch extension folders so a running bot hot-reloads them.

```sh
gurney ext reload             # touch all extension folders
gurney ext reload <name>      # touch one specific extension
```

Hot-reload is triggered by an mtime change on any file in the extension folder. `ext reload` bumps the mtime without needing to edit a file. Use this after manually editing an extension's source while the bot is running.

---

## `gurney ext create`

Scaffold a new extension with the standard layout, ready to edit and install.

```sh
gurney ext create <name>              # scaffold in current directory
gurney ext create <name> <parent>     # scaffold in a specific parent directory
```

Creates `<name>/` with `manifest.json`, `tools.ts`, `commands.ts`, `jobs.ts`, `settings.schema.json`, `prompt.md`, and `README.md` stubs. See [extension-authoring.md](./extension-authoring.md) for what each file does.
