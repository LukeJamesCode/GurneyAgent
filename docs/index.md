# Gurney Documentation

Welcome to the Gurney documentation. The documentation is organized as a sequential curriculum to teach you the setup and architecture of the entire repository.

If you are new here, start with **01. Setup and Deployment**.

---

## 📚 Curriculum

### [01. Setup and Deployment](./01-setup-and-deployment.md)
Step-by-step from zero to a running bot. Covers hardware requirements, native Node vs Docker Compose, the `gurney init` wizard, and the `gurney doctor` pre-flight checks.

### [02. Repository and Architecture](./02-repository-and-architecture.md)
Exactly teaches the repository codebase. Covers the two-queue orchestrator, the deterministic context manager, Ollama HTTP interface, SQLite schemas, and numbered migrations.

### [03. Extensions and Authoring](./03-extensions-and-authoring.md)
Deep dive into the extension loader, Host API, setting schemas, intent patterns, how to build an extension from scratch, and how the bundled extensions work (including Google OAuth setup).

### [04. Operations and Troubleshooting](./04-operations-and-troubleshooting.md)
Day 2 operations. Full environment variable/config reference, Telegram slash commands, troubleshooting common issues, migrating from ATLAS v2, and release processes.

### [05. Multi-Agent Engine](./05-multi-agent.md)
Named agent personas, the resource-aware task queue (one heavy model at a time), supervisor → worker delegation with grant-intersection safety, and the web command center.

---

## 🔗 Quick Links for Reference

- **I want every `gurney` subcommand** → [Operations (CLI Section)](./04-operations-and-troubleshooting.md)
- **I want every Telegram slash command** → [Operations (Telegram Commands)](./04-operations-and-troubleshooting.md#telegram-command-reference)
- **I want to add Google Calendar / Tasks** → [Extensions (Bundled Extensions)](./03-extensions-and-authoring.md#bundled-extensions)
- **I want to write my own extension** → [Extensions and Authoring](./03-extensions-and-authoring.md)
- **Something is broken** → [Operations (Troubleshooting)](./04-operations-and-troubleshooting.md#troubleshooting)
