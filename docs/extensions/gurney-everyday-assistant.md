# gurney-everyday-assistant

Unified everyday assistant. Combines Google Calendar, Google Tasks, local reminders, weather, daily briefings, and a small set of day-planning helpers in one first-party extension.

## What It Adds

- **Calendar**: `calendar_list_events`, `calendar_add_event`, `calendar_quick_add`, `calendar_delete_event`.
- **Tasks**: `tasks_list`, `tasks_add`, `tasks_complete`, `tasks_delete`, `tasks_list_tasklists`.
- **Reminders**: `reminder_set`, `reminder_list`, `reminder_cancel`.
- **Weather**: `weather_get`, backed by Open-Meteo with no API key.
- **Briefings**: `briefing_today`, `briefing_tomorrow`.
- **Advanced planning**: `plan_day`, `find_free_slot`, `smart_schedule_task`, `weather_reschedule_check`.
- **Slash commands**: `/events`, `/addevent`, `/quickadd`, `/delevent`, `/todos`, `/todo`, `/done`, `/tasks`, `/weather`, `/remind`, `/reminders`, `/morningbrief`, `/nightbrief`.
- **Background jobs**: event reminder sweep, reminder sweep, scheduled briefings, and weather-reschedule alerts.

## Setup

1. Follow [Google OAuth setup](../google-oauth-setup.md) to create one OAuth 2.0 client with both Google Calendar API and Google Tasks API enabled.
2. Run `gurney auth gurney-everyday-assistant`.
3. Run `gurney config`, open `gurney-everyday-assistant`, and set `default_location` plus `time_zone` if Gurney runs in UTC.

For scheduled private nudges, set `nudge_chat_id` and `briefing_chat_id`, or trigger `/addevent`, `/quickadd`, `/morningbrief`, or `/nightbrief` once from the chat that should receive them. The extension will not broadcast scheduled personal data to every known chat.

## Slash Commands

| Command         | Arguments                | What it does                                                             |
| --------------- | ------------------------ | ------------------------------------------------------------------------ |
| `/events`       | -                        | List today's calendar events                                             |
| `/addevent`     | `<ISO start> \| <title>` | Add an event: `/addevent 2026-06-01T14:00 \| Dentist`                    |
| `/delevent`     | `<event id>`             | Delete an event by its Google Calendar event ID                          |
| `/quickadd`     | `<natural language>`     | Natural-language quick add: `/quickadd Lunch Friday 1pm`                 |
| `/todos`        | -                        | List incomplete tasks in the default task list                           |
| `/todo`         | `<title>`                | Add a task with no due date: `/todo Buy milk`                            |
| `/done`         | `<title>`                | Mark a task complete by title                                            |
| `/tasks`        | -                        | List available task lists                                                |
| `/weather`      | `[location]`             | Current conditions + 4-day forecast. Uses `default_location` if omitted. |
| `/remind`       | `<time> <message>`       | Set a one-shot reminder: `/remind tomorrow at 9am stand-up`              |
| `/reminders`    | -                        | List upcoming reminders for this chat                                    |
| `/morningbrief` | -                        | Today's weather, events, and tasks                                       |
| `/nightbrief`   | -                        | Evening summary: tomorrow's calendar and outstanding tasks               |

## Settings

| Key                                | Default         | Secret | Notes                                                                                     |
| ---------------------------------- | --------------- | ------ | ----------------------------------------------------------------------------------------- |
| `google_client_id`                 | -               | no     | Google OAuth 2.0 client ID                                                                |
| `google_client_secret`             | -               | yes    | Google OAuth 2.0 client secret                                                            |
| `google_refresh_token`             | -               | yes    | Set by `gurney auth gurney-everyday-assistant`                                            |
| `calendar_id`                      | `primary`       | no     | Google Calendar to read/write                                                             |
| `default_tasklist`                 | `@default`      | no     | Google Tasks list ID                                                                      |
| `nudge_lookahead_minutes`          | `15`            | no     | Minutes before an event starts to send a reminder nudge                                   |
| `nudge_chat_id`                    | -               | no     | Single Telegram chat for event nudges                                                     |
| `default_location`                 | -               | no     | City for weather and briefings                                                            |
| `morning_time`                     | `07:00`         | no     | Morning briefing time in `HH:MM`; weekdays only                                           |
| `night_time`                       | `21:00`         | no     | Evening briefing time in `HH:MM`; every day                                               |
| `time_zone`                        | system timezone | no     | IANA timezone for briefing schedules and displayed calendar times                         |
| `include_weather`                  | `true`          | no     | Include weather in briefings                                                              |
| `include_calendar`                 | `true`          | no     | Include calendar events in briefings                                                      |
| `include_tasks`                    | `true`          | no     | Include tasks in briefings                                                                |
| `briefing_chat_id`                 | -               | no     | Single Telegram chat for scheduled briefings                                              |
| `weather_reschedule_times`         | `06:00,18:00`   | no     | Times (HH:MM, 24-hour, comma-separated) to check outdoor events against worsening weather |
| `learned_routines_enabled`         | `true`          | no     | Enable the routine learner and delivery                                                   |
| `learned_routines_suggestion_cron` | `30 8 * * *`    | no     | Cron for the slow learner that auto-creates new routine rules                             |
| `learned_routines_delivery_cron`   | `* * * * *`     | no     | Cron for delivering due routines; keep at every minute                                    |
| `max_routines_per_week`            | `3`             | no     | Hard ceiling on new auto-learned routines per chat per 7 days                             |

`morning_cron` and `night_cron` are accepted only as legacy migrated settings. New installs should use `morning_time` and `night_time`.

## Background Jobs

| Job                            | Schedule default | What it does                                                                                |
| ------------------------------ | ---------------- | ------------------------------------------------------------------------------------------- |
| Event reminder sweep           | Every 5 minutes  | Sends upcoming event nudges to `nudge_chat_id` or default chat                              |
| Reminder sweep                 | Every minute     | Sends due one-shot reminders to the originating chat                                        |
| Morning briefing               | `07:00` weekdays | Aggregates weather, today's events, and tasks for `briefing_chat_id` or default chat        |
| Evening briefing               | `21:00` daily    | Aggregates tomorrow's calendar and outstanding tasks for `briefing_chat_id` or default chat |
| Weather-reschedule sweep       | `0 6,18 * * *`   | Advanced: flags outdoor events when forecast conditions look bad                            |
| Learned-routine sweep          | `30 8 * * *`     | Slow learner — scans local extension data for recurring patterns and auto-creates rules     |
| Learned-routine delivery sweep | Every minute     | Fires active learned routines when their cron is due                                        |

## Learned Routines

The extension watches three signals to propose recurring nudges automatically: how often the user asks for tomorrow's schedule (nightly prep), how often they review tasks at a specific hour (task review), and reminders that the user has set repeatedly at the same time (recurring reminder). Anything above a hardcoded 0.7 confidence floor becomes a rule in `routine_rules` and fires on its own cron — there is no per-suggestion accept flow.

A hard ceiling of `max_routines_per_week` (default 3) new rules per chat per rolling seven days keeps the bot from going noisy. When the learner adds a rule, Gurney sends a one-time "Learned a new routine" nudge so the user knows what happened.

Two tools manage what's been learned:

- `learned_routine_list` — list active learned routines (id, title, cron, learned-on date).
- `learned_routine_delete` — delete by id or by title substring. Both natural-language phrasings work ("forget the task review routine", "stop the recurring reminder").

## Data Stored

| Table                   | Contents                                                             |
| ----------------------- | -------------------------------------------------------------------- |
| `reminders`             | One-shot reminders: chat ID, due timestamp, message, fired flag      |
| `calendar_nudges_sent`  | Legacy event-nudge dedup rows preserved during upgrades              |
| `smart_scheduled_links` | Links between Google Tasks and calendar events created by scheduling |
| `routine_rules`         | Active learned routines: pattern key, cron, title, text, confidence  |
| `routine_events`        | Audit log of routine creations and deliveries (used for dedup)       |

Google credentials are stored in `extension_settings` in the main SQLite DB. Secret settings are masked in Gurney prompts/status output, but the DB value is plaintext protected by `~/.gurney` file permissions. No data is sent to services other than Google Calendar/Tasks APIs and Open-Meteo.

## Troubleshooting

See [Google OAuth setup](../google-oauth-setup.md) for auth failures. If briefings or reminders stop firing, run `gurney doctor` and confirm `time_zone`, `nudge_chat_id`, and `briefing_chat_id` are set as intended.
