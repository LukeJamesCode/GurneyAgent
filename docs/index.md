# Gurney Documentation

All documentation in one place. Start with [Getting started](./getting-started.md) for setup, then jump to whichever section you need.

---

## By task

- **I want to install Gurney for the first time** → [Getting started](./getting-started.md)
- **I want every `gurney` subcommand** → [CLI reference](./cli-reference.md)
- **I want every Telegram slash command** → [Telegram commands](./telegram-commands.md)
- **I want to add Google Calendar / Tasks / weather / reminders** → [gurney-everyday-assistant](./extensions/gurney-everyday-assistant.md) + [Google OAuth setup](./google-oauth-setup.md)
- **I want to tune for my hardware** → [Hardware and performance](./hardware-and-performance.md)
- **I want to deploy as a service** → [Pi](./deploying-on-raspberry-pi.md) · [Docker](./deploying-with-docker.md)
- **I want to write my own extension** → [Extension authoring](./extension-authoring.md)
- **Something is broken** → [Troubleshooting](./troubleshooting.md)
- **I'm coming from ATLAS** → [Migrating from ATLAS](./migrating-from-atlas.md)

---

## Getting started

| Doc                                                     | What it covers                                             |
| ------------------------------------------------------- | ---------------------------------------------------------- |
| [Getting started](./getting-started.md)                 | Install, the wizard, doctor, start/stop, logs, config      |
| [Configuration reference](./configuration-reference.md) | All env vars and `~/.gurney/config.json` fields            |
| [Troubleshooting](./troubleshooting.md)                 | Common problems and fixes; start here when things go wrong |

---

## Deployment

| Doc                                                         | What it covers                                            |
| ----------------------------------------------------------- | --------------------------------------------------------- |
| [Deploying on Raspberry Pi](./deploying-on-raspberry-pi.md) | OS setup, Ollama install, systemd service                 |
| [Deploying with Docker](./deploying-with-docker.md)         | Docker Compose walkthrough, volumes, updating             |
| [Hardware and performance](./hardware-and-performance.md)   | Tier guide, Ollama tuning, KV cache, speculative decoding |

---

## Reference

| Doc                                                  | What it covers                                                           |
| ---------------------------------------------------- | ------------------------------------------------------------------------ |
| [CLI reference](./cli-reference.md)                  | Every `gurney` subcommand and flag                                       |
| [Telegram command reference](./telegram-commands.md) | All slash commands, grouped by extension                                 |
| [Database schema](./database-schema.md)              | All SQLite tables, column definitions, migration rules                   |
| [Architecture](./architecture.md)                    | Two-queue orchestrator, context manager, extension loader, LLM interface |

---

## Extensions

One page per bundled extension. The `extensions/<name>/` folders hold the runtime code; user-facing docs live here.

| Doc                                                                    | What it covers                                                             |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| [Google OAuth setup](./google-oauth-setup.md)                          | Step-by-step guide for Google Calendar + Tasks authorization               |
| [gurney-everyday-assistant](./extensions/gurney-everyday-assistant.md) | Calendar, tasks, reminders, weather, and briefings (Google OAuth required) |
| [gurney-tts](./extensions/gurney-tts.md)                               | Voice replies via Piper                                                    |
| [gurney-instant-responses](./extensions/gurney-instant-responses.md)   | Instant replies for trivial chatter                                        |
| [gurney-routines](./extensions/gurney-routines.md)                     | Learned routine suggestions (opt-in)                                       |

### Planned (not in the 1.0 bundle)

These extensions shipped during 0.x and are slated to return in v1.4 — see the [Roadmap section in the README](../README.md#roadmap). Their docs are kept here for reference, but they aren't installable from the bundled registry today.

| Doc                                                  | What it covers                        | Target |
| ---------------------------------------------------- | ------------------------------------- | ------ |
| [gurney-websearch](./extensions/gurney-websearch.md) | Web search via DuckDuckGo / SearXNG   | v1.4   |
| [gurney-memgraph](./extensions/gurney-memgraph.md)   | Long-term memory via FalkorDB (heavy) | v1.4   |

---

## Building extensions

| Doc                                                   | What it covers                                                                                                  |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| [Extension authoring guide](./extension-authoring.md) | Full guide: manifest, Host API, settings schema, `intent_pattern`, post-reply hooks, worked example, publishing |

---

## Contributing and operations

| Doc                                               | What it covers                                            |
| ------------------------------------------------- | --------------------------------------------------------- |
| [Contributing](../CONTRIBUTING.md)                | Ground rules, dev setup, quality gates, core vs extension |
| [Security](../SECURITY.md)                        | Threat model, secret handling, reporting vulnerabilities  |
| [Migrating from ATLAS](./migrating-from-atlas.md) | Moving data and configuration from ATLAS v2               |
| [Changelog](../CHANGELOG.md)                      | All user-visible changes by version                       |
| [Release checklist](./release-checklist.md)       | 1.0 release gates (internal)                              |
