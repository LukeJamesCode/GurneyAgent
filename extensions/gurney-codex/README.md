# gurney-codex

**Dual-system escalation.** Keep the cheap local Qwen models doing everyday work, and hand off the hard tasks they can't do at quality to **OpenAI Codex** — billed against your existing **ChatGPT Plus/Pro subscription** via OAuth, not a metered API key.

Codex is a **general** heavy-lifter: complex coding, deep reasoning, detailed writing/planning/analysis. It's told what Gurney is and answers **as Gurney**, in the assistant's own voice — its reply goes straight to you, so the small model never re-chews (and degrades) it. Local stays the default; Codex is only reached on demand, gated by a per-call confirmation and a daily budget.

## How it works

- The local model is given one extra tool, `codex_handoff`. The bundled prompt fragment tells it to call this **only** when a task genuinely exceeds what it can do well — hard coding, deep reasoning, substantial writing/planning/analysis. Everything else — chat, quick answers, and all **actions** (calendar, reminders, weather) — stays on the local model, because Codex has no tools and can't see your data.
- Codex answers in Gurney's voice and that answer is sent to you **verbatim** (the tool is `selfReplying`), so escalating a hard turn doesn't cost you quality.
- Each handoff pops a **Yes/No confirmation** and is metered against a **daily call ceiling** (`daily_call_ceiling`, default 20). Once you hit the ceiling, handoffs are refused until your local midnight.
- You can also invoke Codex explicitly with `/codex <task>` — that's unambiguous consent, so it skips the prompt and replies directly.

## Setup

1. Install and enable the extension:
   ```sh
   gurney ext install ./extensions/gurney-codex
   ```
2. Connect your ChatGPT subscription:
   ```sh
   gurney auth gurney-codex
   ```
   You'll be asked whether a browser is available on this machine:
   - **Yes** → Gurney opens a localhost callback on port `1455` and captures the redirect automatically.
   - **No** (headless Pi over SSH — the common case) → Gurney prints an authorization URL. Open it on any device with a browser, authorise, then copy the `localhost` URL your browser fails to load (it contains `code=…`) and paste it back into the terminal.

   After the token exchange, Gurney runs a one-shot test call against the Codex backend to confirm the token actually works (this catches the [identity-only-scope trap](https://github.com/openclaw/openclaw/issues/29418), where auth "succeeds" but every real call 401s).

## Telegram commands

| Command         | What it does                                            |
| --------------- | ------------------------------------------------------- |
| `/codex <task>` | Send a task straight to Codex; reply is the raw answer. |
| `/codexstatus`  | Today's usage against the daily ceiling, model, auth.   |
| `/codexlogout`  | Forget the stored Codex credentials.                    |

## Configuration

Run `gurney config gurney-codex`. Key settings:

| Setting              | Default                                  | Notes                                          |
| -------------------- | ---------------------------------------- | ---------------------------------------------- |
| `model`              | `gpt-5-codex`                            | Codex model to route handoffs to.              |
| `daily_call_ceiling` | `20`                                     | Hard cap on Codex calls per local day.         |
| `max_output_tokens`  | `4096`                                   | Upper bound on a single Codex answer.          |
| `request_timeout_ms` | `120000`                                 | How long to wait for a Codex response.         |
| `base_url`           | `https://chatgpt.com/backend-api/codex`  | Codex backend; handoffs POST to `/responses`.  |
| `time_zone`          | system tz                                | IANA tz used to bucket the daily ceiling.      |

## Where your credentials live

Codex tokens (access, refresh, id, account id) are stored in Gurney's own `extension_settings` table inside `~/.gurney` — **not** in `~/.codex`. Gurney owns the lifecycle: it refreshes the access token automatically when it nears expiry. `/codexlogout` blanks them.

This means you do **not** need the Codex CLI installed. It also means a future `gurney backup` will capture this auth alongside the rest of your secrets.

## Notes & limitations

- **Consent model.** `codex_handoff` runs at the `confirm` tool tier: every escalation pops a Yes/No prompt in your Telegram chat ("Spend a Codex call on: …?") and only runs if you tap **Yes**. The prompt fails closed — if you don't answer within 2 minutes, or you `/stop` the turn, the call is skipped. The `/codex` command bypasses the prompt because typing it is itself the consent. On top of confirmation, the hard daily budget and the narrow escalation prompt bound how often Codex is ever reached.
- **Endpoints can move.** The OAuth client id, authorize/token URLs, and headers mirror the Codex CLI / OpenClaw flow. If OpenAI rotates them, the constants live at the top of `lib/oauth.ts` and `base_url` is a setting.
- **Context.** Codex can't see your chat. The local model pastes the relevant code/errors into the handoff's `context`; there's no automatic filesystem access (deliberately — it avoids a confused-deputy footgun).

## Tests

```sh
node --import tsx --test extensions/gurney-codex/lib/*.test.ts
```

Covers PKCE/S256, the authorize-URL scope params, JWT account-id extraction, pasted-redirect parsing, the callback server, token exchange/refresh, Responses-API parsing, the budget ledger, and token refresh-on-expiry.
