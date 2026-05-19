# gurney-websearch

> **Status — planned for v1.4.** This extension shipped during the 0.x line and was pulled before 1.0 to keep the public release lean. It's slated to return as an official extension rebuilt against the stable 1.0 host API — see the [Roadmap](../../README.md#roadmap). The page below documents the previous (0.x) behaviour for reference; the v1.4 release will document the final shape. If you want it early, the 0.x source is in the git history.

Web search via DuckDuckGo instant answers, with an optional [SearXNG](https://searxng.github.io/searxng/) backend for full result sets. No API key required for the default backend.

## What it adds

- **Tool**: `web_search` (LLM-callable) — the LLM calls this automatically when it decides a web search would help answer the user's question.

There is no slash command. Search is entirely LLM-driven: ask "what's the latest on Rust 2025?" and the model decides whether to call the tool.

## Setup

```sh
gurney ext install gurney-websearch
gurney ext reload gurney-websearch   # if gurney is already running
```

For the default DuckDuckGo backend, no further configuration is needed. For full web results, point the extension at a SearXNG instance:

```sh
gurney config
# navigate to gurney-websearch → searxng_url → enter your instance URL
```

## Settings

| Key           | Default | Notes                                                                                                |
| ------------- | ------- | ---------------------------------------------------------------------------------------------------- |
| `searxng_url` | —       | Optional SearXNG instance URL (e.g. `https://searx.example.com`). Falls back to DuckDuckGo if unset. |
| `max_results` | `5`     | Default number of results returned per search. Increase for better coverage, lower to save tokens.   |

## How it works

When the LLM determines that a web search is useful, it calls `web_search(query, max_results?)`. The extension fetches results from DuckDuckGo instant answers (or SearXNG if configured), formats them as a result block, and returns the text to the model. The model then uses that text to compose its reply.

Because results flow through the model before reaching the user, the model filters irrelevant hits and synthesises a direct answer rather than dumping raw links.

## Running your own SearXNG

SearXNG is a self-hosted meta search engine. It gives the extension access to full web results rather than instant-answer snippets. Running it alongside Gurney is straightforward:

```yaml
# Add to your docker-compose.yml
searxng:
  image: searxng/searxng:latest
  ports:
    - '8080:8080'
```

Then set `searxng_url` to `http://searxng:8080` (or `http://localhost:8080` if running natively).

## Resource notes

Network only. No local storage, no auth, no background jobs. Safe on a Pi 4.
