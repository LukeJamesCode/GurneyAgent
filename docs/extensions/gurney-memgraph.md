# gurney-memgraph

> **Status — planned for v1.4.** This extension shipped during the 0.x line and was pulled before 1.0 to keep the public release lean. It's slated to return as an official heavy-tier extension rebuilt against the stable 1.0 host API — see the [Roadmap](../../README.md#roadmap). The page below documents the previous (0.x) behaviour and bridge contract for reference; the v1.4 release will document the final shape. If you want it early, the 0.x source is in the git history.

Long-term memory for Gurney, backed by [FalkorDB](https://www.falkordb.com/) + [Graphiti](https://github.com/getzep/graphiti) running behind a small Python HTTP bridge.

The bridge is a separate process. The IPC and Embedded transports ATLAS shipped are deliberately not carried over — HTTP is the only wire format. This keeps Gurney core CPU-cheap (the LLM and graph work happen out-of-process) and lets one bridge serve multiple Gurney installs by namespace.

## What it adds

- **Tool** `recall_memory(query, top_k?)` — the LLM calls this when the user references a detail outside the visible history.
- **Tool** `store_memory(text)` — the LLM calls this only when the user explicitly asks to remember something.
- **Slash commands** `/memory <query>`, `/remember <text>`, `/forget`.
- **Background sweep** every 15 minutes (configurable cron) that ships freshly exchanged user/assistant turns to the bridge for fact extraction.

## Setup

1. Run the bridge somewhere reachable from Gurney (a sibling container is the common case — uncomment the `falkordb` service in `docker-compose.yml` and add the bridge alongside).
2. `gurney config gurney-memgraph` and set:
   - `bridge_url` (default `http://localhost:8765`)
   - `namespace` (default `default`)
   - `bridge_token` if the bridge requires auth.

## Bridge contract

The bridge must implement:

- `GET /health` → `{ "ok": true }`
- `POST /memory/recall` `{ namespace, query, top_k }` → `{ "facts": [{ "text", "score?", "source?", "created_at?" }] }`
- `POST /memory/store` `{ namespace, source, episodes: [{ text, created_at, role? }] }` → `{ "stored": <int> }`
- `POST /memory/forget` `{ namespace }` → `{ "ok": true }`

## Hardware

This is a heavy extension. The bridge plus FalkorDB is several hundred MB resident; do not enable it on a Pi 4. Standard / Heavy tier devices only.
