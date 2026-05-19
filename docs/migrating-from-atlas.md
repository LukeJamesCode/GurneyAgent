# Migrating from ATLAS v2

Gurney is the public successor to ATLAS v2. If you've been running ATLAS on your homelab, this guide helps you bring your data and workflow across.

---

## What carries over

| ATLAS data                  | Gurney equivalent                   | Migration status                                     |
| --------------------------- | ----------------------------------- | ---------------------------------------------------- |
| Conversations and messages  | `conversations` + `messages` tables | Via migration tool                                   |
| Long-term memory (MemGraph) | `gurney-memgraph` extension         | Via migration tool (if gurney-memgraph installed)    |
| Skills config               | Extensions config                   | Manual — see below                                   |
| Google OAuth tokens         | None                                | Re-run `gurney auth` — tokens are scoped differently |

---

## What doesn't carry over

- **Skills → Extensions**: ATLAS skills become Gurney extensions, but settings are not automatically imported. See the section below.
- **Web UI state**: Gurney has no web UI. All web-UI-only data (preferences set through the ATLAS dashboard) has no equivalent.
- **Commute alerts, voice gateway, Tailscale TLS**: deliberately cut from Gurney. No migration path.
- **ATLAS `/atlasupdate` command**: removed for security. Use `gurney update` instead.

---

## Migration tool

The migration tool lives in `tools/migrate-from-atlas/`. It reads an ATLAS `atlas.db` SQLite file and imports conversations, messages, and (optionally) MemGraph memories into a Gurney database.

### Prerequisites

- Gurney installed and `gurney init` completed (so `~/.gurney/gurney.db` exists with the schema applied)
- `gurney-memgraph` installed and the bridge running (only if you want to migrate memories)
- A copy of your ATLAS database (`data/atlas.db` in the ATLAS repo)

### Run the migration

```sh
# From the Gurney repo root
node tools/migrate-from-atlas/index.js \
  --source /path/to/atlas.db \
  --target ~/.gurney/gurney.db
```

**Options:**

| Flag              | Default               | Notes                                                          |
| ----------------- | --------------------- | -------------------------------------------------------------- |
| `--source`        | (required)            | Path to the ATLAS SQLite database                              |
| `--target`        | `~/.gurney/gurney.db` | Path to the Gurney SQLite database                             |
| `--chat-id`       | all                   | Only migrate conversations for this Telegram chat ID           |
| `--skip-memories` | false                 | Skip MemGraph memory migration even if the bridge is reachable |
| `--dry-run`       | false                 | Print what would be migrated without writing anything          |

**Dry run first:**

```sh
node tools/migrate-from-atlas/index.js \
  --source /path/to/atlas.db \
  --dry-run
```

---

## Manual steps after migration

### Calendar, tasks, reminders, weather, and briefings

All of these are now combined in `gurney-everyday-assistant`. Install once, authorize once:

1. Install the extension:
   ```sh
   gurney ext install gurney-everyday-assistant
   ```
2. Re-authorize (ATLAS tokens used different scopes):
   ```sh
   gurney auth gurney-everyday-assistant
   ```
3. Configure settings:
   ```sh
   gurney config   # → gurney-everyday-assistant → default_location, time_zone, etc.
   ```

ATLAS reminders stored in the database are not automatically migrated — the schema differs. Re-create important ones with `/remind <time> <message>` or natural language.

### Web search

```sh
gurney ext install gurney-websearch
```

---

## Running ATLAS and Gurney in parallel

During the migration you can run both:

- ATLAS keeps its own Ollama connection and Telegram bot
- Gurney uses a different bot token (create a new one with @BotFather)

Once Gurney is working to your satisfaction, revoke the ATLAS bot token or stop the ATLAS process, and point `gurney auth` at the old token if you want to keep the same bot username.

---

## Key differences in behaviour

| Feature        | ATLAS                              | Gurney                                         |
| -------------- | ---------------------------------- | ---------------------------------------------- |
| Setup          | Web UI admin panel                 | `gurney init` terminal wizard                  |
| Extensions     | Skills folder, hot-reload via POST | Extensions folder, filesystem-watch hot-reload |
| Memory         | MemGraph always on (homelab)       | `gurney-memgraph` extension, opt-in            |
| Telegram bot   | Long-poll                          | Long-poll (same)                               |
| Config storage | Environment vars + DB              | `~/.gurney/config.json` + env var override     |
| Multi-model    | Multiple providers wired           | Ollama only; multi-provider stays as interface |
