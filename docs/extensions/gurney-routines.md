# gurney-routines

Learns lightweight routine candidates from local extension data (calendar, tasks, briefings) and asks before turning them into recurring nudges. Designed to feel proactive without going behind your back — every routine is opt-in.

## What it adds

- **Slash commands**: `/routines`, `/routine`.
- **Cron**: a low-frequency learner that proposes new routines, plus a per-minute delivery tick for accepted routines.
- **SQLite tables**: `routine_candidates`, `routine_suggestions`, `routine_rules` (per-extension migrations).

## Slash commands

| Command                | What it does                                                        |
| ---------------------- | ------------------------------------------------------------------- |
| `/routines`            | List pending suggestions and active accepted routines for this chat |
| `/routine accept <id>` | Accept a suggestion and turn it into a recurring routine rule       |
| `/routine pause <id>`  | Pause an active routine without deleting it                         |
| `/routine delete <id>` | Delete a routine rule                                               |
| `/routine why <id>`    | Explain what evidence and source extensions produced the suggestion |

## How it works

1. On a slow cron (default 8:30am daily), the learner scans signals from other installed extensions — calendar event patterns, recurring tasks, briefing engagement — and proposes routine candidates with a confidence score.
2. Candidates whose confidence is above `confidence_threshold` (default `0.7`) become suggestions sent to the configured chat: "It looks like you usually have stand-up at 9am on weekdays — want me to remind you 5 minutes before?"
3. You answer with `/routine accept <id>`, `/routine pause <id>`, `/routine delete <id>`, or `/routine why <id>` to see the reasoning.
4. Accepted suggestions become rules in `routine_rules`. A per-minute delivery cron fires the nudge when each rule is due.
5. Suggestions are rate-limited per chat by `max_suggestions_per_week` (default 3) so the bot never feels spammy.

## Settings

| Key                        | Default      | Notes                                                                                                                                                  |
| -------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `enabled`                  | `true`       | Enable routine learning and accepted-routine delivery. Set to `false` to disable without uninstalling.                                                 |
| `suggestion_cron`          | `30 8 * * *` | Cron for the learner. Default: 8:30am daily. Don't run more often than hourly — the learner is intentionally slow.                                     |
| `delivery_cron`            | `* * * * *`  | Cron for checking accepted routines that are due. Leave at every minute for precise delivery.                                                          |
| `max_suggestions_per_week` | `3`          | Maximum routine suggestions sent per chat over any rolling seven-day window.                                                                           |
| `confidence_threshold`     | `0.7`        | Minimum confidence (0–1) required before the extension sends a suggestion. Raise if you find suggestions noisy; lower if you want more proactive ones. |
| `default_chat_id`          | `0`          | Optional Telegram chat id for suggestions and routines. When `0`, uses the host Telegram chat id.                                                      |
| `auto_accept_suggestions`  | `false`      | Explicit opt-in: automatically create routine rules instead of asking first. Off by default so the bot never adds nudges without your say-so.          |

## Data stored

| Table                 | What it holds                                                                                  |
| --------------------- | ---------------------------------------------------------------------------------------------- |
| `routine_candidates`  | Patterns the learner discovered, with a title, proposed cron, confidence, and evidence summary |
| `routine_suggestions` | Per-chat record of which candidates were sent as suggestions, with `pending`/accepted/rejected |
| `routine_rules`       | Accepted routines: title, cron, status (`active`, `paused`, `deleted`)                         |

All data is local. Nothing is sent to any external service.

## Resource notes

SQLite + a slow daily cron + a per-minute delivery tick. Negligible CPU overhead. Safe on a Pi 4.
