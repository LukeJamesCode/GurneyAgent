# Getting started

Step-by-step setup for a fresh Gurney install. If you already have the bot running and want the rest of the surface, skip to [CLI reference](./cli-reference.md) or pick an extension under [`/docs/extensions/`](./index.md#extensions).

## Prerequisites

| Requirement               | Notes                                                                |
| ------------------------- | -------------------------------------------------------------------- |
| **Node.js ≥ 20**          | `node --version` to check                                            |
| **Ollama**                | Running locally or on your network. [ollama.com](https://ollama.com) |
| **A Telegram bot token**  | Create one with [@BotFather](https://t.me/BotFather) — `/newbot`     |
| **Your Telegram user ID** | [@userinfobot](https://t.me/userinfobot) will tell you               |
| **≥ 4 GB RAM**            | 8 GB+ recommended for the `standard` tier chat model                 |

Pull the chat model before you start Gurney so it's ready immediately:

```sh
ollama pull qwen3.5:0.8b        # small / standard tier chat model
ollama pull qwen3.5:9b          # optional — reasoning profile (standard / heavy)
```

---

## Install

### Option A — native Node (recommended for development)

```sh
git clone https://github.com/LukeJamesCode/GurneyAgent.git
cd GurneyAgent
npm install
npm run build
```

After the build, `./dist/cli/index.js` is the CLI entry point. Link it globally so you can run `gurney` from anywhere:

```sh
npm link          # adds `gurney` to your PATH via the bin field in package.json
```

### Option B — Docker Compose (recommended for always-on deployments)

The Compose file runs Ollama and Gurney as separate containers. Ollama is intentionally not bundled into Gurney's image — a Gurney redeploy should never reload a 9B model from scratch.

```sh
git clone https://github.com/LukeJamesCode/GurneyAgent.git
cd GurneyAgent
docker compose up -d
```

The Gurney container reads config from env vars (see [Configuration reference](./configuration-reference.md)) or from a `/data/config.json` volume-mounted at `GURNEY_HOME`. Run `gurney init` inside the container for a guided setup:

```sh
docker compose exec gurney node dist/cli/index.js init
```

Full deployment guides: [Deploying on Raspberry Pi](./deploying-on-raspberry-pi.md) · [Deploying with Docker](./deploying-with-docker.md).

---

## 1. First-run wizard — `gurney init`

Run this once (or again any time you need to change the core settings):

```
gurney init
```

The wizard walks you through six steps in order:

1. **Telegram bot token** — validated live against `getMe`; retries if the token is rejected.
2. **Allowed Telegram user IDs** — comma-separated list of numeric IDs. Only these users can talk to your bot.
3. **Ollama URL** — defaults to `http://localhost:11434`. Probed immediately; if Ollama is down you can skip and fix it later with `gurney models`.
4. **Chat model** — pick from the live model list returned by Ollama, or enter a tag manually.
5. **Reasoning model** — optional heavier model for complex tasks. Choose `(skip)` on small devices.
6. **Hardware tier** — auto-suggested from your total RAM. Override freely.

Config is written to `~/.gurney/config.json` with mode `0600`. Re-running `init` loads your previous values as defaults — you only need to change what's different.

Config file location: `~/.gurney/config.json` (override with `GURNEY_HOME`).

---

## 2. Pre-flight check — `gurney doctor`

Run this before the first start to catch any missing pieces:

```
gurney doctor
```

`doctor` runs nine checks in parallel and prints a `✓` / `✗` summary for each:

| Check        | What it verifies                                                          |
| ------------ | ------------------------------------------------------------------------- |
| `home`       | `~/.gurney/` exists                                                       |
| `config`     | All required keys are set (token, allowedIds, ollama URL, chat model)     |
| `ram`        | Total system RAM ≥ 4 GB                                                   |
| `disk`       | At least 1 GB free on the partition holding `~/.gurney/`                  |
| `extensions` | Every folder under `extensions/` has a valid `manifest.json`              |
| `migrations` | `_migrations` table is present, no pending or mismatched files            |
| `ports`      | Ollama's port is held (so something is actually listening locally)        |
| `telegram`   | Bot token passes a live `getMe` call                                      |
| `ollama`     | Ollama URL is reachable and the configured chat/reason models are present |

Exits non-zero and prints `N check(s) failed.` if anything is wrong — safe to use in scripts or CI.

---

## 3. Start the bot — `gurney start`

Foreground (logs to stdout):

```sh
gurney start
```

Background daemon (logs to `~/.gurney/log/gurney.log`):

```sh
gurney start --detach
```

`--detach` spawns a child process, writes its PID to `~/.gurney/gurney.pid`, and exits immediately. The bot is ready once you see a `[info] ollama reachable` line in the log.

Gurney refuses to double-start — if a PID file points at a live process, `start` will exit with an error telling you to run `gurney stop` first.

What `gurney start` wires up (in order):

1. Logger (with an optional file sink at `~/.gurney/log/gurney.log`)
2. SQLite at `~/.gurney/gurney.db` + numbered migrations
3. Ollama LLM client (chat + optional reasoning profile)
4. Tool registry
5. Scheduler (cron tick, nudge dispatcher)
6. Extension loader — discovers everything in `<repo>/extensions/` and `~/.gurney/extensions/`, registers tools/commands/jobs; watches for hot-reload on file changes
7. Orchestrator (per-chat user queue + background job worker)
8. Telegram long-poll adapter

---

## 4. Monitor the running bot

```sh
gurney status          # one-shot health summary (running?, ollama?, extensions, job queue, fast-cache hit rate)
gurney status --json   # machine-readable
gurney logs            # print the full log file
gurney logs --follow   # tail -f the log file (Ctrl-C to stop)
```

`gurney status` output example:

```
home         /home/pi/.gurney
running      yes (pid 12345)
ollama       ok @ http://localhost:11434 (3 models)
chat model   qwen3.5:0.8b
reason model qwen3.5:9b
allowlist    123456789
extensions   gurney-everyday-assistant
scheduler    4 jobs, 1284 ticks, 17 nudges sent
fast-cache   83% hit rate (215/259, 64 keys)
```

---

## 5. Stop the bot

```sh
gurney stop
```

Sends `SIGTERM` to the PID recorded in `~/.gurney/gurney.pid`. The process drains its queues, shuts down the scheduler and extension loader, and exits cleanly.

---

## 6. Reconfigure — `gurney config` and `gurney models`

```sh
gurney config     # interactive TUI for all core settings + any installed extension's settings.schema.json
gurney models     # re-run only the model-picker step from init
```

`gurney config` lets you edit Telegram token, allowlist, Ollama URL, log level, and any per-extension knobs defined in an extension's `settings.schema.json`. Changes are persisted to `~/.gurney/config.json` and, for extension settings, to the `extension_settings` table in SQLite.

---

## 7. Manage extensions — `gurney ext`

```sh
gurney ext list                            # show all installed extensions and their state
gurney ext install <path|git-url|name>     # install from a local folder, a git URL, or a registry name
gurney ext enable  <name>                  # enable a disabled extension
gurney ext disable <name>                  # disable without uninstalling
gurney ext uninstall <name>                # remove the extension folder (settings kept)
gurney ext uninstall <name> --purge        # remove folder + drop settings from DB
gurney ext reload [<name>]                 # touch extension folder(s) so a running bot hot-reloads them
gurney ext create <name> [dir]             # scaffold a new extension ready to publish
```

Install sources (in priority order):

| Source        | Example                                                           |
| ------------- | ----------------------------------------------------------------- |
| Local path    | `gurney ext install ./my-extension`                               |
| Git URL       | `gurney ext install https://github.com/user/gurney-something.git` |
| Registry name | `gurney ext install gurney-everyday-assistant`                    |

Installed extensions land in `~/.gurney/extensions/<name>/`. A running Gurney instance hot-reloads any extension whose folder is touched (mtime change) without restarting.

Install the everyday assistant extension (calendar, tasks, reminders, weather, briefings):

```sh
gurney ext install gurney-everyday-assistant
gurney auth gurney-everyday-assistant        # run the Google OAuth flow
gurney ext reload gurney-everyday-assistant  # if gurney is already running
```

Full per-extension docs live under [`/docs/extensions/`](./index.md#extensions).

---

## 8. Authenticate an extension — `gurney auth`

```sh
gurney auth <extension-name>
```

Imports the extension's `auth.ts`, runs its declared flow with terminal-bound prompts, and writes the returned credentials into the `extension_settings` table. For extensions with an OAuth redirect, a local HTTP callback server is started automatically.

See [Google OAuth setup](./google-oauth-setup.md) for the Calendar / Tasks flow walkthrough.

---

## Quick-start cheatsheet

```sh
# 1. Install
git clone https://github.com/LukeJamesCode/GurneyAgent.git && cd GurneyAgent
npm install && npm run build && npm link

# 2. Pull the model
ollama pull qwen3.5:0.8b

# 3. Configure
gurney init

# 4. Verify
gurney doctor

# 5. Run
gurney start --detach

# 6. Check
gurney status
gurney logs --follow
```

---

## Where to go next

- Configure something more advanced: [Configuration reference](./configuration-reference.md)
- Tune for your hardware: [Hardware and performance](./hardware-and-performance.md)
- Pick extensions: [`/docs/extensions/`](./index.md#extensions)
- Things going wrong: [Troubleshooting](./troubleshooting.md)
- Write your own extension: [Extension authoring guide](./extension-authoring.md)
