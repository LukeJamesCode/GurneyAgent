# Gurney

> Small, terminal-first AI agent. CPU-only. Extensions turn it into anything.

**Status:** v0.7 (Phase 7 in progress) — feature-complete; running through the [release checklist](./docs/release-checklist.md) toward 1.0.

## What it is

A self-hosted local-AI agent built around Ollama and qwen3.5. Designed to run on devices as small as a Raspberry Pi 4. Core does almost nothing on its own — drop in extensions to add Google Calendar, Tasks, long-term memory, voice replies, web search, and anything else.

You chat with Gurney through Telegram. You configure it through a terminal CLI. There is no web UI.

## Design pillars

1. **Runs on small devices** — Pi 4, Pi 5, mini PCs, anything CPU-only with ≥4 GB RAM
2. **Extensions are mods** — drop a folder into `~/.gurney/extensions/`, new tools and Telegram commands appear, no restart, no glue code
3. **Telegram is the chat surface** — no web UI in v1
4. **Terminal-only setup** — `gurney init`, `gurney config`, `gurney auth`, `gurney ext install`, `gurney start`
5. **CPU-only, qwen3.5-native** — Ollama is the only wired LLM provider; multi-provider stays as a clean interface

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

Need more detail? The full setup walkthrough is in [docs/getting-started.md](./docs/getting-started.md).

## Documentation

Everything user-facing lives under [`docs/`](./docs/index.md):

- **[Getting started](./docs/getting-started.md)** — step-by-step setup, the wizard, doctor, start/stop, logs, config
- **[CLI reference](./docs/cli-reference.md)** — every `gurney` subcommand and flag
- **[Telegram command reference](./docs/telegram-commands.md)** — every slash command, grouped by extension
- **[Configuration reference](./docs/configuration-reference.md)** — env vars and `~/.gurney/config.json` fields
- **[Extensions](./docs/index.md#extensions)** — one page per bundled extension
- **[Architecture](./docs/architecture.md)** — two-queue orchestrator, context manager, extension loader, LLM interface
- **[Hardware and performance](./docs/hardware-and-performance.md)** — tier guide, Ollama tuning, KV cache, spec decode
- **[Deploying on Raspberry Pi](./docs/deploying-on-raspberry-pi.md)** · **[Deploying with Docker](./docs/deploying-with-docker.md)**
- **[Extension authoring](./docs/extension-authoring.md)** — write your own
- **[Troubleshooting](./docs/troubleshooting.md)** — when things go wrong

## Roadmap

See [CHANGELOG.md](./CHANGELOG.md) for what has shipped, and [docs/release-checklist.md](./docs/release-checklist.md) for the remaining 1.0 gates.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). To report a security issue, see [SECURITY.md](./SECURITY.md).

## License

Apache License 2.0 — see [LICENSE](./LICENSE).

## Predecessor

Gurney is the public, clean-room successor to a private homelab agent called **ATLAS v2**. Gurney drops ATLAS's homelab-specific bits (commute alerts, ESP32 voice puck, Tailscale auto-cert, web UI) and rebuilds the rest as composable extensions. See [Migrating from ATLAS](./docs/migrating-from-atlas.md) if you're coming from there.
