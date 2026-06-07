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

Discord is **opt-in by user**:

- **DMs** are allowed only when your Discord user id is on the
  `allowed_dm_user_ids` allowlist.
- **Guild channels** respond only when (a) your bot is **@-mentioned**
  AND (b) the author is on the same `allowed_dm_user_ids` allowlist. The
  mention is mandatory in guilds — default-on group intercept is forbidden
  by the safety doc.

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

This one allowlist gates both surfaces: a user on it can DM the bot, and
can talk to it in any guild channel by @-mentioning it. There is no
per-channel opt-in — the bot replies in whatever channel an allowlisted
user mentions it in.

Restart (or hot-reload) Gurney; the bridge picks up the new allowlist
within a few seconds.

### 5. Try it

DM the bot from an allowlisted user, or @-mention it in any guild channel
as that same user. The reply comes back from the same model, with the same
memory, as your Telegram conversations.

## Slash commands

Inside Discord, three native slash commands are exposed:

- `/gurney` — tell you whether you're on the allowlist (and how to chat
  if you are). Replies ephemerally (only you see it).
- `/vcjoin` — summon Gurney into the voice channel you're currently in
  (server only). See [Voice](#voice).
- `/vcleave` — dismiss Gurney from the voice channel.

Adding or removing users from the allowlist happens via `gurney config
gurney-discord` on the host — never via a model-driven path. This is
intentional: the safety doc bans "model-driven allowlist edits."

## Settings reference

| Key                       | Type     | Default | Description                                                                |
| ------------------------- | -------- | ------- | -------------------------------------------------------------------------- |
| `bot_token`               | string\* | _none_  | Bot token from the Developer Portal. Required. Marked `secret`.            |
| `allowed_dm_user_ids`     | csv      | `""`    | Discord user IDs allowed to DM **and** to mention the bot in guilds. Empty = no access. |
| `rate_limit_per_minute`   | number   | `10`    | Max user-initiated turns per Discord user per minute.                      |
| `shared_telegram_chat_id` | number   | `0`     | `0` = each Discord DM is its own thread. Set to your Telegram chat id to share one conversation/history across both surfaces (DMs only). See note below. |
| `proactive_dm_user_id`    | string   | `""`    | Discord user id to DM proactive briefings/nudges to. Empty = first `allowed_dm_user_ids` entry. |
| `idle_disconnect_minutes` | number   | `0`     | Reserved — disconnect after N idle minutes. `0` = stay connected.          |
| `entrance_sounds`         | map      | `""`    | `<user_id>:<absolute_path_to_mp3>,...` — play this sound when that user joins a voice channel Gurney is in. See [Voice](#voice). |
| `talking_sounds`          | map      | `""`    | `<user_id>:<absolute_path_to_mp3>,...` — play this sound whenever that user starts talking in a voice channel. See [Voice](#voice). |

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

## Voice

Gurney can sit in a Discord voice channel, listen for a wake word,
transcribe what you say, run it through the **same pipeline** as a text
turn, and speak the reply back into the channel.

This piggybacks on the **gurney-voice** extension — install and set that
up first. gurney-discord reads gurney-voice's resolved binary/model paths
(whisper for STT, piper for TTS, plus ffmpeg) straight from its settings;
without them, voice-in and voice-out silently no-op. The bot's invite also
needs the `Connect` and `Speak` voice permissions (in addition to the text
permissions in [step 3](#3-build-an-invite-url)).

**Joining and leaving.** Join a voice channel yourself, then run `/vcjoin`
— Gurney drops into your channel. `/vcleave` dismisses it. Both are
server-only.

**Talking to it.** While Gurney is in the channel, prefix what you say
with the wake word — **"gurney …"** or **"hey gurney …"**. Everything
after the wake word is handled exactly like an @-mention: same model, same
memory, same tools. The reply is synthesised and spoken back into the
channel. Bare "gurney" with nothing after it gets a short "I'm here."

Voice is gated by the same allowlist as text: only speech from a user on
`allowed_dm_user_ids` is transcribed and acted on. Everyone else's audio
is ignored.

**Sound effects.** Two optional settings play a local MP3 for a specific
user (handy for entrance stings or talk-over gags). They fire **alongside**
the wake-word assistant — you don't have to choose between them:

- `entrance_sounds` — plays when that user **joins** a voice channel
  Gurney is already in.
- `talking_sounds` — plays when that user **starts talking**.

If you want a pure soundboard with no assistant at all, flip `taunt_mode`
on: Gurney then plays the sounds but stops transcribing speech and ignores
the wake word. With `taunt_mode` off (the default), the wake word and the
sound effects both work at once.

Both take the form `<user_id>:<absolute_path_to_mp3>`, comma-separated for
multiple users:

```
123456789012345678:/home/me/sounds/entrance.mp3,987654321098765432:/home/me/sounds/airhorn.mp3
```

Paths may themselves contain commas (e.g. `Liam - Energetic, Social Media
Creator.mp3`) — entries are split only at a `,<digits>:` boundary, so a
comma inside a path is preserved.

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
  `allowed_dm_user_ids`, or (in a guild) the bot wasn't @-mentioned.
- **Mention required in guilds.** In a guild channel the bot must be
  @-mentioned (`@gurney explain this`) **and** you must be on
  `allowed_dm_user_ids`. Bare messages are ignored in every channel —
  that's the safety property, not a bug.
- **"Used Disallowed intents" on login.** Re-open the Developer
  Portal, enable **Message Content Intent**, and re-`gurney auth
  gurney-discord` is not needed; the next gateway reconnect picks the
  new intent up.
- **Token reset.** If you suspect the token leaked, hit **Reset Token**
  in the Developer Portal and re-run `gurney auth gurney-discord`.
