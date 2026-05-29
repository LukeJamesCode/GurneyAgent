# gurney-frontend

A local web control panel for Gurney. It serves a friendly browser UI on your
LAN that mirrors the CLI: first-run setup, starting/stopping the agent, chatting
with your local model, managing extensions, editing core settings, running
diagnostics, and following logs — without ever opening a terminal.

The CLI stays fully usable on its own; this extension is strictly opt-in.

## Running it

```sh
gurney ext install gurney-frontend   # generates an access token, prints the URL
gurney frontend                      # start the panel (Ctrl-C to stop)
gurney frontend --detach             # run it in the background
gurney frontend stop                 # stop a backgrounded panel
```

Then open the printed URL, e.g. `http://127.0.0.1:7777/?token=…`.

## How it works

- **Separate process from the agent daemon.** The panel runs on its own so its
  Start/Stop buttons can drive `gurney start --detach` / `gurney stop` without
  the server killing itself. The daemon is "the agent"; the panel just controls
  it.
- **`server.ts`** is a small Node `http` server (no extra npm deps). It serves
  the static UI from `web/` and a JSON API under `/api`. Read-only data reuses
  the same core helpers the CLI does (`effectiveConfig`, `probeOllama`,
  `collectDoctorChecks`, `collectExtensionReadiness`, the SQLite settings
  store); mutating actions shell out to the `gurney` CLI.
- **`web/`** is a no-build single-page app: React + Babel-standalone from a CDN
  transpile the `.jsx` files in the browser. A Raspberry Pi can serve it as-is.
- **Direct chat** streams through Gurney's orchestrator: the same model profile
  routing, extension tools, conversation history, prompt fragments, and
  guardrails used by Telegram. It is gated on the agent running so it matches
  your Telegram conversation. The Chat Hub has full parity with the Telegram
  chat surface:
  - **Full tool use, incl. confirm-tier tools.** A confirm-tier tool (e.g.
    `gurney-codex`'s `codex_handoff`) pops an inline Approve/Decline card via a
    `confirm` SSE event (`/api/chat/confirm`); it fails closed on
    timeout/disconnect, exactly like Telegram's Yes/No prompt.
  - **Commands & buttons.** Core text commands (`/help`, `/model`, `/status`,
    `/extensions`, `/lasterror`) and every enabled extension command (`/codex`,
    `/codexstatus`, …) run via `/api/command` and surface as one-click buttons.
    No-arg commands run immediately; arg commands prefill the input.
  - **Dev mode.** A toggle appends model/timing/tool diagnostics under each
    reply (parity with Telegram `/devmode`).
  - **Voice both ways.** With `gurney-voice` installed, spoken replies stream
    back as a `voice` SSE event and autoplay; the mic button records and POSTs
    to `/api/chat/voice-in` (whisper.cpp), then sends the transcript.

## Settings

| key           | default     | meaning                                                            |
| ------------- | ----------- | ----------------------------------------------------------------- |
| `listen_host` | `127.0.0.1` | Bind address. Use `0.0.0.0` to reach it from other LAN devices.   |
| `listen_port` | `7777`      | TCP port.                                                         |
| `auth_token`  | _generated_ | Shared token required for the API when not on loopback.           |
| `proactive`   | `true`      | Whether the agent may send unprompted nudges (Chat Hub toggle).   |

When `listen_host` is not loopback, the API requires the `auth_token` (passed as
`?token=` once, then kept in `sessionStorage`). Secrets are masked in API
responses and never overwritten by their masked placeholder.

## Layout

```
manifest.json          extension manifest (capabilities: network, storage)
settings.schema.json   host/port/token/proactive schema (drives the UI form)
setup.ts               install hook: ensure token, print URL
server.ts              HTTP server + /api
web/                   the browser UI
  index.html  styles.css  api.js  data.jsx
  components.jsx  app.jsx  chathub.jsx  extensions.jsx  settings.jsx  system.jsx  wizard.jsx
```
