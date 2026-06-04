# gurney-discord

A second chat surface for Gurney. One Gurney process, two front doors —
Telegram and Discord — sharing the same model, memory, tool registry,
extensions, and confirm-tier UX.

## What this is

A Discord bridge that runs inbound messages through the **same shared
pipeline** Telegram uses (`host.chat.dispatchInbound`), so Discord is a
first-class surface, not a stripped-down one. You get the same:

- **Extension commands** — `@Gurney /tasks`, `@Gurney /briefing`, etc. Any
  command an extension registers works here (typed after the mention).
- **Message intercepts** — instant replies and routing run the same way, so
  trivial chatter ("hi", "thanks") is handled cleanly instead of being thrown
  at the model raw.
- **Proactive** — morning/night briefings, event reminders, and nudges are
  **mirrored** to Discord (DM'd to you) alongside Telegram.
- **Tools, memory, learned routines, scheduled jobs** — all shared.

The model doesn't know which surface it's talking through. By default each
Discord DM is its own conversation thread; set `shared_telegram_chat_id` to
fuse it with your Telegram thread (see Settings).

Discord is **opt-in by chat**:

- **DMs** are allowed only when your Discord user id is on the
  `allowed_dm_user_ids` allowlist.
- **Guild channels** respond only when (a) your bot is **@-mentioned**
  AND (b) the channel is in `allowed_channel_keys`. This is per-chat
  opt-in; default-on group intercept is forbidden by the safety doc.

Confirm-tier tools (anything that mutates state, escalates to Codex,
spends money, etc.) pop a Discord message with two buttons:

> Hand this to Codex (deep-reasoning brain)?  
> "rewrite the auth middleware to use JWE"
>
> [ **✓ Confirm** ] [ **✗ Cancel** ]

Confirm prompts are **single-use**, time-boxed (60s), and resolve via the
core router that Telegram also routes through — no free-text "yes/no".

## Install

```sh
gurney ext install gurney-discord
```

Then create the bot, capture the token, and pick an allowlist.

### 1. Create the Discord application

1. Open <https://discord.com/developers/applications>.
2. Click **New Application**, give it a name (e.g. _Gurney_), and Create.
3. In the sidebar, choose **Bot**.
4. Under **Privileged Gateway Intents**, enable **Message Content
   Intent**. Without this the bot cannot read DMs or @-mentions.
5. Click **Reset Token** (or **Add Bot** on a fresh application) and
   copy the value. **Treat it like a password** — anyone with this token
   can act as the bot.

### 2. Hand the token to Gurney

```sh
gurney auth gurney-discord
```

You'll be prompted (masked) for the bot token. It's written into the
extension's SQLite `extension_settings` row, never to env or
`config.json`. Re-running `auth` overwrites the value.

### 3. Build an invite URL

In the Developer Portal sidebar, open **OAuth2 → URL Generator**:

- **Scopes:** `bot`, `applications.commands`.
- **Bot Permissions:** check at minimum:
  - `Send Messages`
  - `Read Message History`
  - `Use Slash Commands`
  - For confirm-tier UX, the bot also needs `Embed Links` (button
    components don't need a separate permission).

The page renders a URL at the bottom — paste it into your browser, pick
the server, and approve.

### 4. Add the allowlist

```sh
gurney config gurney-discord
```

Set:

- `allowed_dm_user_ids` — comma-separated Discord user IDs. Get a user
  id by enabling **Developer Mode** in Discord (User Settings →
  Advanced → Developer Mode) and right-clicking your name → **Copy User
  ID**.
- `allowed_channel_keys` — comma-separated `<guild_id>:<channel_id>`
  pairs for channels the bot should listen in (still requires
  @-mention). Right-click a channel name → **Copy Channel ID**;
  right-click a server icon → **Copy Server ID** for the guild id.

Restart (or hot-reload) Gurney; the bridge picks up the new allowlist
within a few seconds.

### 5. Try it

DM the bot from an allowlisted user, or @-mention it in an opted-in
channel. The reply comes back from the same model, with the same memory,
as your Telegram conversations.

## Slash commands

Inside Discord, only one slash command is exposed:

- `/gurney` — show whether the current channel is opted in. Replies
  ephemerally (only you see it).

Adding or removing chats happens via `gurney config gurney-discord` on
the host — never via a model-driven path. This is intentional: the
safety doc bans "model-driven allowlist edits."

## Settings reference

| Key                       | Type     | Default | Description                                                                |
| ------------------------- | -------- | ------- | -------------------------------------------------------------------------- |
| `bot_token`               | string\* | _none_  | Bot token from the Developer Portal. Required. Marked `secret`.            |
| `allowed_dm_user_ids`     | csv      | `""`    | Discord user IDs allowed to DM.                                            |
| `allowed_channel_keys`    | csv      | `""`    | `<guild_id>:<channel_id>` pairs the bot will reply in (on @-mention).      |
| `rate_limit_per_minute`   | number   | `10`    | Max user-initiated turns per Discord user per minute.                      |
| `shared_telegram_chat_id` | number   | `0`     | `0` = each Discord DM is its own thread. Set to your Telegram chat id to share one conversation/history across both surfaces (DMs only). See note below. |
| `proactive_dm_user_id`    | string   | `""`    | Discord user id to DM proactive briefings/nudges to. Empty = first `allowed_dm_user_ids` entry. |
| `idle_disconnect_minutes` | number   | `0`     | Reserved — disconnect after N idle minutes. `0` = stay connected.          |

**Identity (`shared_telegram_chat_id`).** Default `0` keeps Discord DMs on an
isolated conversation thread (long-term memory is still shared). Set it to your
Telegram chat id and Discord DMs append to that same thread — one continuous
conversation across both surfaces. Only DMs are shared; guild channels always
stay isolated (they can't merge into a personal thread). Trade-off: in shared
mode, confirm-tier prompts render in **Telegram**, not as Discord buttons,
because the chat id is no longer a Discord id.

**Proactive (`proactive_dm_user_id`).** Briefings, nudges, and reminders fire
from the same scheduler jobs Telegram uses; core mirrors each one to every chat
surface. Discord delivers them as a DM to this user. The bot must share a guild
with the user (or the user must allow DMs) for the send to succeed.

`bot_token` is plaintext in SQLite (`~/.gurney/state.db`,
`extension_settings` table). Treat the file as you would a `.env`. The
`secret: true` flag masks it in `gurney config` and `gurney status`.

## Identity model

Discord snowflakes are 64-bit integers and exceed JavaScript's
`Number.MAX_SAFE_INTEGER`, so we cannot use them as the orchestrator's
`chatId` directly. Instead, the extension assigns each
`(discord_user_id, discord_channel_id)` pair a synthetic negative integer
drawn from a private namespace and persists the mapping in its own
`discord_chats` table.

`isDiscordChatId(n)` is a numeric range check. The core confirm router
uses it to route confirm-tier prompts to this surface instead of
Telegram. The range was chosen to not collide with Telegram user IDs
(positive) or Telegram supergroup IDs (≤ -1,000,000,000,000).

## Confirm-tier safety

The renderer in `lib/confirm.ts` enforces:

- **Single-use** — token deleted from the pending map on first click; any
  later click on either button gets a stale-ack and is ignored.
- **Time-boxed (60s)** — auto-deny if no tap arrives in time.
- **Abort-aware** — the originating turn's `AbortSignal` resolves the
  promise false and edits the prompt to "Cancelled" if `/stop` fires
  (or, on Discord, if the message gets deleted by the user).
- **Fail-closed** — if the prompt couldn't be sent (channel deleted,
  missing permissions), the confirm-tier tool refuses.

Buttons are the safety requirement. There is no free-text "yes" fallback
— a user cannot be tricked by an injection into typing "ok please" to
approve an action.

## Capability

Declares `capabilities: ["network", "storage", "chat_surface"]`. The
`chat_surface` capability is the marker for "this extension owns a chat
surface other than Telegram"; it's the same capability future Matrix or
Slack extensions would declare.

## What this isn't

- No voice channels (out of scope for v1).
- Extension commands run as text after a mention (`@Gurney /tasks`), not as
  **native** Discord slash commands. `/gurney` is the only registered native
  slash command; mirroring every extension command into Discord's slash UI is a
  later polish, not a v1 requirement.
- No embed-based confirm prompts — buttons only.
- No `/gurney auto-approve` or any auto-yes mode. Money/auth/destructive
  actions need a human tap, always.

## Troubleshooting

- **Bot is online but doesn't respond.** Check `gurney status` and
  `/discord` in Telegram. Most likely your Discord user id isn't on
  `allowed_dm_user_ids`, or the channel pair isn't on
  `allowed_channel_keys`, or the bot wasn't @-mentioned in the channel.
- **DM tokens for guilds.** In a guild channel the bot must be
  @-mentioned (`@gurney explain this`). Bare messages are ignored even
  in opted-in channels — that's the safety property, not a bug.
- **"Used Disallowed intents" on login.** Re-open the Developer
  Portal, enable **Message Content Intent**, and re-`gurney auth
  gurney-discord` is not needed; the next gateway reconnect picks the
  new intent up.
- **Token reset.** If you suspect the token leaked, hit **Reset Token**
  in the Developer Portal and re-run `gurney auth gurney-discord`.
