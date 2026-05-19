<p align="center">
  <img src="docs/assets/gurney-banner.png" alt="Gurney — AI Agent" width="100%" />
</p>

<p align="center">
  <a href="./LICENSE"><img alt="License" src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" /></a>
  <a href="./CHANGELOG.md"><img alt="Version" src="https://img.shields.io/badge/version-1.0.0-green.svg" /></a>
  <img alt="Node" src="https://img.shields.io/badge/node-%E2%89%A520-brightgreen.svg" />
  <img alt="Platform" src="https://img.shields.io/badge/platform-linux%20%7C%20rpi%20%7C%20mini--pc-lightgrey.svg" />
  <img alt="CPU-only" src="https://img.shields.io/badge/CPU--only-yes-success.svg" />
  <a href="./CONTRIBUTING.md"><img alt="PRs welcome" src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg" /></a>
</p>

<p align="center">
  <b>A small, terminal-first, self-hosted AI agent.</b><br/>
  <i>CPU-only. Runs on a Raspberry Pi. Extensions turn it into anything you want.</i>
</p>

<p align="center">
  <a href="./docs/getting-started.md">Getting started</a> ·
  <a href="./docs/extension-authoring.md">Build an extension</a> ·
  <a href="./docs/index.md">Docs</a> ·
  <a href="./CHANGELOG.md">Changelog</a> ·
  <a href="./CONTRIBUTING.md">Contributing</a>
</p>

---

## What Gurney is

Gurney is a self-hosted local-AI agent built around [Ollama](https://ollama.com) and qwen3.5. It runs on devices as small as a Raspberry Pi 4 — no GPU, no cloud round-trip, no telemetry. You chat with it through Telegram. You configure it from a terminal. There is no web UI.

The core does almost nothing on its own. **Everything interesting is an extension** — a folder you drop into `~/.gurney/extensions/`. Calendar, tasks, reminders, weather, daily briefings, long-term memory, voice replies, web search — all of it lives outside core, and you can add, remove, fork, or write your own without ever touching the engine.

If the bundled extensions don't fit your life, throw them away and write your own. That's the point.

## Why I made it

I wanted an assistant that:

- **Lives on hardware I own** — a $50 Pi on my shelf, not someone else's server.
- **Default-private** — no telemetry, no usage analytics, no "free tier" that becomes a paid tier next quarter. The default chat loop is fully local on hardware you own; any cloud-backed providers are strictly opt-in.
- **Bends to me, not the other way around** — if I want a `/standup` command that pulls from my own scripts, I shouldn't have to file a feature request. I should write 40 lines and drop a folder in.
- **Doesn't need a datacenter** — runs full-time at single-digit watts.
- **Doesn't lock me in** — Apache-2.0, plain SQLite for state, JSON config you can read with `cat`. If Gurney goes away tomorrow, your data is yours.

It started as a private homelab agent called **ATLAS v2**. Gurney is the clean-room, public successor: everything personal stripped out, everything reusable rebuilt as composable extensions.

## Built to be modular

> The five-word version: **extensions are mods, not plugins.**

Gurney's core is a chat loop, a context manager, a tool dispatcher, and an extension loader. That's it. Every user-visible feature ships as an extension folder with a manifest:

```
gurney-myext/
├── manifest.json          ← declares tools, /commands, jobs, capabilities
├── tools.ts               ← LLM-callable tools
├── commands.ts            ← Telegram /commands
├── jobs.ts                ← scheduled cron jobs
├── auth.ts                ← `gurney auth gurney-myext` flow
├── settings.schema.json   ← typed config, rendered automatically by `gurney config`
├── prompt.md              ← system-prompt fragment
└── migrations/            ← your own SQLite tables
```

Drop the folder in, and new LLM tools and Telegram commands appear — **no restart, no glue code, no central registry to edit**. Pull it out, and they vanish. Extensions can register their own DB migrations, their own scheduled jobs, their own OAuth flows, and their own system-prompt fragments. They're sandboxed to their own data directory and declare their capabilities upfront.

This means you can shape Gurney into whatever assistant you actually want:

| Want…                          | …write an extension that…                                          |
| ------------------------------ | ------------------------------------------------------------------ |
| A homelab dashboard buddy      | exposes `restart_service`, `disk_usage`, `docker_ps` as LLM tools  |
| A study companion              | adds `/quiz`, `/flashcard`, and a spaced-repetition job            |
| A workshop / 3D-printer agent  | wraps OctoPrint's API and adds `/print_status`, `/cancel`          |
| A personal CRM                 | stores contacts, registers a daily `/who_to_follow_up` briefing    |
| A finance tracker              | parses bank emails via IMAP, registers `/spend_this_week`          |
| Something nobody's built yet   | …go for it. The host API is documented and stable.                 |

The [Extension authoring guide](./docs/extension-authoring.md) walks through the manifest, the `Host` API, lifecycle, testing, and publishing. Scaffold one in a single command:

```sh
gurney ext create gurney-myext
gurney ext install ./gurney-myext
```

## What's in the box

These extensions ship with Gurney. Each is optional — disable any of them with one config flag:

| Extension                    | What it does                                                          |
| ---------------------------- | --------------------------------------------------------------------- |
| `gurney-everyday-assistant`  | Calendar, tasks, reminders, weather, daily briefings (Google OAuth)   |
| `gurney-tts`                 | Voice replies via Piper + ffmpeg                                      |
| `gurney-routines`            | Learned routine suggestions, opt-in, asks before recurring nudges     |
| `gurney-instant-responses`   | Templated instant replies for trivial chatter and tool acks           |

## Design pillars

These are the trade-offs Gurney makes. They're load-bearing — if you disagree with any of them, you probably want a different agent:

1. **Runs on small devices.** Pi 4 / Pi 5 / mini PC, anything CPU-only with ≥4 GB RAM. If a feature can't run on a Pi 5, it ships as an opt-in extension.
2. **Extensions are mods.** If you have to touch core to add a feature, the extension API has failed.
3. **Telegram is the chat surface.** No web UI in v1.
4. **Terminal-only setup.** `gurney init`, `gurney config`, `gurney auth`, `gurney ext install`, `gurney start`.
5. **CPU-only, qwen3.5-native.** Ollama is the only wired LLM provider; the multi-provider interface stays clean for the future.

## Quick start

```sh
# 1. Install
git clone https://github.com/LukeJamesCode/GurneyAgent.git && cd GurneyAgent
npm install && npm run build && npm link

# 2. Pull the model
ollama pull qwen3.5:0.8b

# 3. Configure, verify, run
gurney init
gurney doctor
gurney start --detach
gurney status
```

Prefer Docker? See [docs/deploying-with-docker.md](./docs/deploying-with-docker.md). Deploying to a Raspberry Pi as a systemd service? [docs/deploying-on-raspberry-pi.md](./docs/deploying-on-raspberry-pi.md). Stuck? [docs/troubleshooting.md](./docs/troubleshooting.md).

The full setup walkthrough is in [docs/getting-started.md](./docs/getting-started.md).

## Hardware

Gurney is designed around the constraint of running on cheap silicon. Rough guidance — see [Hardware and performance](./docs/hardware-and-performance.md) for the full tier guide:

| Tier      | Example hardware              | What runs                                 |
| --------- | ----------------------------- | ----------------------------------------- |
| Light     | Pi 4 (4 GB), Pi 5 (4 GB)      | Core + everyday-assistant                 |
| Standard  | Pi 5 (8 GB), N100 mini PC     | Above + TTS + routines                    |
| Heavy     | 5800H / Ryzen mini PC, 16 GB+ | Above + heavier optional extensions       |

## Documentation

Everything user-facing lives under [`docs/`](./docs/index.md):

- **[Getting started](./docs/getting-started.md)** — step-by-step setup, the wizard, doctor, start/stop, logs, config
- **[CLI reference](./docs/cli-reference.md)** — every `gurney` subcommand and flag
- **[Telegram command reference](./docs/telegram-commands.md)** — every slash command, grouped by extension
- **[Configuration reference](./docs/configuration-reference.md)** — env vars and `~/.gurney/config.json` fields
- **[Architecture](./docs/architecture.md)** — two-queue orchestrator, context manager, extension loader, LLM interface
- **[Hardware and performance](./docs/hardware-and-performance.md)** — tier guide, Ollama tuning, KV cache, spec decode
- **[Deploying on Raspberry Pi](./docs/deploying-on-raspberry-pi.md)** · **[Deploying with Docker](./docs/deploying-with-docker.md)**
- **[Extension authoring](./docs/extension-authoring.md)** — write your own
- **[Troubleshooting](./docs/troubleshooting.md)** — when things go wrong

## Project status

**v1.0** — shipped. The host API for extensions is stable; breaking changes will be called out in [CHANGELOG.md](./CHANGELOG.md) with a deprecation window. See the [Roadmap](#roadmap) below for what's coming in 1.x.

## Contributing

Contributions are welcome — but most of them belong in an **extension**, not in core. See [CONTRIBUTING.md](./CONTRIBUTING.md) for the ground rules, dev setup, quality gates, and the core-vs-extension call.

If you build an extension, open a PR to add it to [`extensions/registry.json`](./extensions/registry.json) so other users can discover it.

To report a security issue, follow the process in [SECURITY.md](./SECURITY.md) — please don't open a public issue for vulnerabilities.

## Acknowledgements

- [Ollama](https://ollama.com) — the local LLM runtime Gurney is built on
- [Qwen](https://github.com/QwenLM) — the model family Gurney is tuned for
- [grammY](https://grammy.dev) — the Telegram bot framework
- [Piper](https://github.com/rhasspy/piper) — fast local TTS
- [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) — the storage backbone

Gurney is the public, clean-room successor to a private homelab agent called **ATLAS v2**. Coming from there? See [Migrating from ATLAS](./docs/migrating-from-atlas.md).

## Roadmap

Gurney 1.0 is the stable baseline. The roadmap below sketches what's planned for the 1.x line. Versions are targets, not promises — order may shift as priorities settle.

### Returning from pre-1.0

These extensions shipped during the 0.x line and were pulled before 1.0 to keep the public release lean. They're slated to return as official extensions, rebuilt against the stable host API:

| Extension          | What it does                                              | Target |
| ------------------ | --------------------------------------------------------- | ------ |
| `gurney-websearch` | Web search as an LLM tool (DuckDuckGo / SearXNG)          | 1.x    |
| `gurney-memgraph`  | Long-term graph memory (FalkorDB / Graphiti, heavy tier)  | 1.x    |

### Planned for 1.1 – 1.5

_The version buckets below are being scoped — see open discussion in the repo._

- **API & subscription providers** — pluggable LLM backends so Gurney can optionally route through Anthropic, OpenAI, Google, or other providers, including subscription-based auth (e.g. Codex / ChatGPT / Claude sub auth) for users who'd rather reuse an existing plan than mint an API key. Local Ollama remains the default; cloud providers stay strictly opt-in.
- _(More items will land here as the 1.x scope is locked in.)_

## License

[Apache License 2.0](./LICENSE) — use it, fork it, ship it, sell what you build on top. Just keep the notice.
