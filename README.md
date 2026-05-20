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

It started as a private homelab agent called **ATLAS**. Gurney is the clean-room, public successor: everything personal stripped out, everything reusable rebuilt as composable extensions.

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
| `gurney-everyday-assistant`  | Calendar, tasks, reminders, weather, briefings, learned routines (Google OAuth) |
| `gurney-tts`                 | Voice replies via Piper + ffmpeg                                      |
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
| Standard  | Pi 5 (8 GB), N100 mini PC     | Above + TTS                               |
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

Gurney 1.0 is the stable baseline. The 1.x line below is grouped into coherent releases — each version is a theme rather than a dumping ground. Versions are targets, not promises; order may shift as priorities settle.

### Returning from pre-1.0

Two extensions shipped during the 0.x line and were pulled before 1.0 to keep the public release lean. They're slated to return as official extensions, rebuilt against the stable host API:

| Extension          | What it does                                              | Target |
| ------------------ | --------------------------------------------------------- | ------ |
| `gurney-websearch` | Web search as an LLM tool (DuckDuckGo / SearXNG)          | v1.4   |
| `gurney-memgraph`  | Long-term graph memory (FalkorDB / Graphiti, heavy tier)  | v1.4   |

### v1.1 — Surfaces I: web UI + voice in

- **Optional web UI extension** — strictly opt-in, terminal-first remains the default. Useful for browsing histories, editing config, and managing extensions on the LAN without a Telegram round-trip.
- **`gurney-stt` (voice input)** — local Whisper.cpp / Vosk transcription so Telegram voice notes flow into the chat loop as normal user turns.

### v1.2 — Multi-provider engine

- **Pluggable LLM providers** — first-class backends for Anthropic, OpenAI, Google, OpenRouter, and friends, alongside the default local Ollama. Per-profile routing (chat vs. reason vs. tools).
- **Subscription-based auth** — reuse an existing paid plan (Codex / ChatGPT / Claude sub auth and equivalents) instead of minting an API key. Tokens stay in `~/.gurney` with the rest of your secrets.
- **Hybrid routing policy** — "cheap local first, escalate to cloud on hard turns" with per-chat budgets and an audit trail of which provider answered each turn.

Local Ollama remains the default. Cloud providers stay strictly opt-in.

### v1.3 — Surfaces II: vision + Discord

- **`gurney-vision`** — local VLM (LLaVA-class) so the model can answer about images sent through whichever surface you use.
- **Discord adapter** — second chat surface as an official extension, same host API as the Telegram adapter.

### v1.4 — The returning extensions + streaming

- **`gurney-websearch` ** — DuckDuckGo + SearXNG aggregator, with optional Brave / Kagi backends and a clean cite-as-you-answer prompt fragment.
- **`gurney-memgraph` ** — long-term graph memory, rebuilt against the stable 1.0 host API. Heavy tier only.
- **Streaming Telegram replies** — token-by-token edits instead of one-shot send, so long answers feel live.

### v1.5 — Data trust release

- **Conversation export / import** — Markdown + JSON, per-chat or per-thread.
- **Auto-update on a cadence** — `gurney update --auto` with an opt-in systemd timer.
- **Encrypted secrets at rest** — wrap `~/.gurney/config.json` and OAuth tokens with a keyring or passphrase-derived key.
- **Backup & restore** — one command to snapshot SQLite + config to a local path or S3-compatible bucket, and one command to restore.

### v1.6 — Information extensions

A coherent "pull the outside world in" release.

- **`gurney-files`** — local RAG over a chosen folder of notes, PDFs, or scans.
- **`gurney-email`** — IMAP triage, draft writer, and "summarise overnight" rolled into briefings.
- **`gurney-rss`** — feed reader + daily digest that plugs into the briefing pipeline.

### v1.7 — Homelab tier

For the people running Gurney next to their rack.

- **`gurney-homeassistant`** — Home Assistant REST/WebSocket bridge.
- **`gurney-shell`** — sandboxed shell runner with command allowlists.
- **`gurney-code`** — git / repo helper: `/diff`, `/lastcommit`, "review this branch".

### v1.8 — Money + chat reach

- **`gurney-finance`** — bank-email parsing and spend summaries (the use case teased in the README table above).
- **Matrix adapter** — third chat surface for users on self-hosted Matrix homeservers.

### v1.9 — Extension ecosystem

Sharpening the developer experience so third-party extensions can land safely.

- **`gurney ext search <kw>`** — registry-aware discovery from the CLI.
- **Extension signing & checksum verification** — opt-in, but a clear path for trusting third-party extensions.
- **Extension test harness** — `gurney ext test ./my-ext` runs your extension inside a mocked host.

### v2.0 — Agentic leap

- **`gurney-browser`** — sandboxed browser automation, building on the agentic-safety and confused-deputy design already drafted in [`future-plans/agentic-safety-and-browser-automation.md`](./future-plans/agentic-safety-and-browser-automation.md). This is the milestone that earns the major-version bump: it changes what Gurney can *do*, not just what it can talk about, and the safety model needs to land first.

## License

[Apache License 2.0](./LICENSE) — use it, fork it, ship it, sell what you build on top. Just keep the notice.
