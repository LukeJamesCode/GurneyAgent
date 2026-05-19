# gurney-instant-responses

Templated instant replies for trivial chatter and tool-dispatch acknowledgements. Reduces perceived latency by sending an immediate response before the LLM finishes — and skips the LLM entirely for messages that don't need it.

## What it adds

Two behaviours, registered as a Telegram message intercept:

1. **Trivial-chatter bypass** — messages like "hi", "thanks", "ok", "lol", "good morning" get a templated reply instantly with no LLM call. On a Pi 4 this saves 2–8 seconds for messages that don't need a model.

2. **Tool-dispatch acknowledgement** — messages that look like tool/query intent ("set an event", "what's the weather", "remind me to…") get an instant "On it." or "Checking." ack while the orchestrator works in the background. The real reply follows when the LLM finishes.

This mirrors the instant-reply table in ATLAS v2.

## Setup

```sh
gurney ext install gurney-instant-responses
gurney ext reload gurney-instant-responses   # if gurney is already running
```

No settings, no auth, no external dependencies.

## How it works

The extension registers a message intercept that runs before the orchestrator:

1. Check if the message matches a trivial-chatter pattern (short, social, no semantic content).
2. If yes: send a templated reply, call `ctx.return()` to skip the orchestrator entirely.
3. If no: check if the message matches a tool-intent pattern using keyword heuristics.
4. If yes: send an ack ("On it. / Checking.") and call `ctx.next()` so the orchestrator still runs.
5. If neither: pass through without touching anything.

The intercept is a best-effort heuristic. It will occasionally misfire (a genuine question phrased like chatter gets a templated reply). If you find it annoying, disable it:

```sh
gurney ext disable gurney-instant-responses
```

## Resource notes

No storage, no network, no model calls. Negligible CPU. Safe on any hardware.
