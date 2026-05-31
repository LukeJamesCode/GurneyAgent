# Telegram Command Reference

All slash commands available in Gurney. Core commands are always present. Extension commands appear when that extension is installed and enabled.

Use `/help` in the bot to see the commands currently active on your install, grouped by source.

---

## Core commands

Always available. No extension required.

| Command        | Arguments     | What it does                                                                                                                                  |
| -------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `/start`       | —             | Welcome message and quick how-to                                                                                                              |
| `/help`        | —             | List all installed commands grouped by extension                                                                                              |
| `/newchat`     | —             | Reset conversation context. Starts a new conversation; the current history is archived but not deleted.                                       |
| `/stop`        | —             | Cancel an in-flight reply. Sends an abort signal to the active LLM call.                                                                      |
| `/model`       | —             | Show the active model profiles (chat / reason / tools) and whether devmode is on                                                              |
| `/status`      | —             | Bot uptime, Ollama health, installed extensions, job queue depth                                                                              |
| `/lasterror`   | —             | Show the last orchestrator error for this chat (useful when a reply silently failed)                                                          |
| `/extensions`  | —             | List installed extensions and their enabled/disabled state                                                                                    |
| `/devmode`     | `on` \| `off` | Append per-reply diagnostics (model, token counts, elapsed time) to each response                                                             |
| `/setup`       | —             | Owner-only setup wizard in Telegram: token, allowlist, Ollama URL, model choices, hardware tier, bundled extension selection, auth, settings. |
| `/fresh`       | —             | Owner-only destructive fresh rebuild from Telegram: update checkout, wipe `~/.gurney`, then run the Telegram setup wizard.                    |
| `/cancelsetup` | —             | Cancel an active `/setup` or `/fresh` wizard.                                                                                                 |

### Fresh/setup from Telegram

`/setup` and `/fresh` are owner-only because they can rewrite config, enable extensions, and collect extension secrets.
They are intended for the case where Gurney is already reachable over Telegram and you want to rebuild or reconfigure a remote host without SSH.

| Command        | What it does                                                                                                                                                 |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/setup`       | Runs the setup wizard in chat without wiping existing state. It saves `config.json`, presets bundled extension enable/disable rows, and walks auth/settings. |
| `/fresh`       | Requires an exact `YES` confirmation, runs the same update path as `/update`, wipes `~/.gurney`, then runs the setup wizard in chat.                         |
| `/cancelsetup` | Cancels the active wizard for your Telegram user. You can also reply `cancel` to any setup prompt.                                                           |

Telegram cannot send a truly blank response, so the wizard tells you when to reply `default` to keep a shown default value.
After a successful `/fresh` or `/setup`, run `/doctor` to verify the new config and `/restart` to boot the process with the rebuilt config/extension set.

`/setup` and `/fresh` still require the current bot process to be reachable first; keep the existing token during the wizard if you want to stay on the same Telegram bot.

---

## gurney-everyday-assistant

Requires `gurney-everyday-assistant` installed. Calendar and tasks commands also require Google OAuth authorization (`gurney auth gurney-everyday-assistant`).

| Command         | Arguments                | What it does                                                                       |
| --------------- | ------------------------ | ---------------------------------------------------------------------------------- |
| `/events`       | —                        | List today's calendar events                                                       |
| `/addevent`     | `<ISO start> \| <title>` | Add an event: `/addevent 2026-06-01T14:00 \| Dentist`                              |
| `/delevent`     | `<event id>`             | Delete an event by its Google Calendar event ID                                    |
| `/quickadd`     | `<natural language>`     | Natural-language quick add: `/quickadd Lunch with Sam Friday 1pm`                  |
| `/todos`        | —                        | List incomplete tasks in the default task list                                     |
| `/todo`         | `<title>`                | Add a task: `/todo Buy milk`                                                       |
| `/done`         | `<title>`                | Mark a task complete by title (partial match)                                      |
| `/tasks`        | —                        | List all available task lists and their IDs                                        |
| `/weather`      | `[location]`             | Current conditions + 4-day forecast. Uses `default_location` if no argument given. |
| `/remind`       | `<time> <message>`       | Set a reminder: `/remind tomorrow 9am stand-up`                                    |
| `/reminders`    | —                        | List all upcoming (unfired) reminders                                              |
| `/morningbrief` | —                        | Today's weather, calendar events, and task list                                    |
| `/nightbrief`   | —                        | Evening summary: today's tasks done, tomorrow's events, tomorrow's weather         |

Reminder time formats: relative (`in 30 minutes`), date/time (`2026-06-01 15:00`), or natural language (`friday noon`, `tomorrow morning`). All capabilities are also available via natural language without slash commands.

See [gurney-everyday-assistant docs](./extensions/gurney-everyday-assistant.md) for setup, settings, and auth.

---

## gurney-memgraph — planned, v1.4

The `/memory`, `/remember`, and `/forget` commands shipped during 0.x and will return when `gurney-memgraph` lands as an official extension again in v1.4. See the [Roadmap](../README.md#roadmap).

---

## gurney-voice

Requires `gurney-voice` installed and Piper + whisper.cpp + ffmpeg available.

| Command             | Arguments                 | What it does                                                                                                      |
| ------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `/voice`            | `on` \| `off` \| `status` | Toggle voice replies for this chat. When on, every text reply also gets a voice note.                             |
| `/voice transcribe` | `on` \| `off` \| `status` | Toggle voice-to-text. When on, voice notes you send are transcribed by whisper.cpp and answered like typed input. |

Voice notes you send while transcription is off get a polite "voice notes aren't enabled" reply — turn it on per chat with `/voice transcribe on`.

---

## Notes

### Command suggestions in Telegram

When Gurney starts (or restarts), it calls `setMyCommands` to register all active slash commands with Telegram. Type `/` in the chat to see the suggestion menu. Commands from newly installed extensions appear after the next `gurney ext reload` or bot restart.

### LLM tools vs. slash commands

Many capabilities are available both as slash commands and as LLM tools. Slash commands give you direct, predictable control. LLM tools let you use natural language — "what's the weather in Oslo?" routes to `get_weather` without needing `/weather Oslo`. Either approach works; use whichever fits the moment.

### Per-chat state

`/devmode`, `/voice`, and conversation context are all per-chat. Toggling devmode in one chat doesn't affect another.
