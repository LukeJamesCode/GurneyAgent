# future-plans/

Forward-looking design documents for work that has been thought through but not yet started.

This folder is **not** for shipped behavior — that lives in [`docs/`](../docs/). Use `future-plans/` for designs that:

- have a clear motivation and approach,
- have been discussed enough that a contributor could pick them up,
- but are not on the immediate roadmap.

When it ships, move the user-facing parts into `docs/` and the version-history note into [`CHANGELOG.md`](../CHANGELOG.md), then replace the file with a short "implemented in commit / PR ###" stub or delete it.

## Index

- [`agentic-safety-and-browser-automation.md`](./agentic-safety-and-browser-automation.md) — `gurney-browser` extension, sandboxed extension execution, prompt-injection and confused-deputy defenses. Borrows what's worth borrowing from OpenClaw without breaking Gurney's North Stars.
- [`gurney-tudor-guided-learning.md`](./gurney-tudor-guided-learning.md) — `gurney-tudor` extension: a NotebookLM-style guided-learning panel that compiles a topic into a full interactive course up front (hiding local-inference latency), then plays it back instantly. qwen-primary, codex-optional, voice-over in phase 2.
