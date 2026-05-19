# Contributing to Gurney

Thanks for taking a look. Gurney is small on purpose: most contributions belong in an _extension_, not in core. Read [docs/architecture.md](./docs/architecture.md) before designing anything that touches `src/core/`.

## Ground rules

The five North Star values in [CLAUDE.md](./CLAUDE.md) decide every trade-off:

1. **Runs on small devices.** Pi 4 / Pi 5 / mini PC / 5800H — anything CPU-only with ≥4 GB RAM. If a feature can't run on a Pi 5, it ships as an opt-in extension.
2. **Extensions are mods.** If a contributor must touch core to add a feature, the extension API has failed.
3. **Telegram is the chat surface.** No web UI in v1.
4. **Terminal-only setup.** `gurney` CLI + interactive TUI. No browser.
5. **CPU-only, qwen3.5-native.** Ollama is the only wired LLM provider.

When two designs disagree, the one that better serves these wins.

## Project layout

```
src/
  adapters/       — telegram (and future channels)
  cli/            — `gurney …` subcommands, TUI flows
  core/           — orchestrator, context manager, llm, tools, extensions, scheduler
  storage/        — SQLite + numbered migrations
  util/           — logger, redact, etc.
extensions/       — first-party extensions, each its own folder + tsconfig
scripts/          — build helpers, test runner, benchmarks
```

Anything new that adds capability (Calendar, Tasks, Memory, etc.) goes under `extensions/<name>/`. Core changes are reserved for the extension API itself, the LLM/Telegram plumbing, and CLI.

## Setup

```sh
git clone https://github.com/LukeJamesCode/GurneyAgent.git
cd GurneyAgent
npm install
npm run build
npm link        # makes the `gurney` binary available globally
```

You'll need:

- Node ≥ 20
- A local Ollama instance (`ollama pull qwen3.5:0.8b` is enough to start)
- A Telegram bot token + your numeric user ID (only needed if you want to run end-to-end)

## Quality gates

Run these before opening a PR — CI runs the same set on Node 20 and 22:

```sh
npm run lint           # ESLint (strict)
npm run format:check   # Prettier (run `npm run format` to auto-fix)
npm run typecheck      # tsc --noEmit on core + every bundled extension
npm test               # Node test runner across all *.test.ts files
docker compose config  # validates docker-compose.yml
```

Add a `*.test.ts` next to whatever you touched; the test runner walks `src/` and picks them up automatically.

## What goes in core vs. an extension

| If your change…                                          | Build it as                             | Why                                              |
| -------------------------------------------------------- | --------------------------------------- | ------------------------------------------------ |
| Adds a Telegram slash command users will install         | extension                               | Mods, not core                                   |
| Adds a tool the LLM can call (calendar, weather, search) | extension                               | Mods, not core                                   |
| Adds long-term memory / vector store / RAG               | extension                               | Heavy, opt-in only                               |
| Adds TTS, STT, voice anything                            | extension                               | Heavy, opt-in only                               |
| Adds a new way to register tools, commands, jobs         | core                                    | Extension API surface                            |
| Tightens prompt assembly, context budgeting              | core                                    | Affects every extension                          |
| Adds another LLM provider                                | core (via the existing `LLM` interface) | Multi-provider stays an interface                |
| Changes the SQLite schema for core tables                | core (numbered migration only)          | Use a real migration; never `addColumnIfMissing` |

If the answer isn't obvious, open an issue first.

## Commit style

Match the existing log: terse, imperative, "why not what" in the subject. PRs that touch one concern are easier to review than PRs that bundle four.

## Things explicitly NOT to do

- No web UI, no service worker, no `public/`, no React in core
- Don't bundle Ollama into Gurney
- Don't use `addColumnIfMissing`; write a numbered migration in `src/storage/migrations/`
- Don't hardcode timezones, IPs, or `/opt/...` paths
- Don't carry over ATLAS-isms (commute, voice gateway, Tailscale TLS, MemGraph IPC bridge)

## Writing an extension

See [docs/extension-authoring.md](./docs/extension-authoring.md) for the full guide, including manifest shape, every registry the host exposes, the auth-flow contract, settings schemas, and how to publish.

## Reporting bugs / asking for features

Open an issue. For a security bug, please email rather than file publicly — see [SECURITY.md](./SECURITY.md) if it exists, otherwise contact the repo owner directly.

## License

By contributing, you agree your work is licensed under the project's Apache License 2.0 (see [LICENSE](./LICENSE)).
