import type { Host } from '../../../src/core/extensions.js';
import { parseReminderTime, splitReminderArgs } from '../helpers/time.js';

const REMINDER_SET_INTENT =
  '\\b(remind me|set a reminder|reminder|notify me|ping me|alarm|timer|countdown)\\b';
const REMINDER_LIST_INTENT = '\\b(reminders|what reminders|upcoming reminders)\\b';
const REMINDER_CANCEL_INTENT = '\\b(cancel|delete|remove).*(reminder|alarm|timer)\\b';

interface ReminderRow {
  id: number;
  chat_id: number;
  text: string;
  fire_at: number;
}

export function register(host: Host): void {
  host.tools.register({
    name: 'reminder_set',
    intentPattern: REMINDER_SET_INTENT,
    description:
      'Schedule a one-shot reminder that pings the user at a specific moment. ' +
      "Use when the user says 'remind me to X in 30 minutes', 'remind me to X at 4pm', 'ping me when ...'. " +
      'Do NOT use for open-ended TODOs (use `tasks_add`) or for time-blocked appointments on the calendar (use `calendar_quick_add`). ' +
      'Rule of thumb: a reminder fires a notification at one moment and then is done; a task is a TODO with no notification; an event takes up time on the calendar.',
    tier: 'auto',
    // `text` and `time` are conceptually required, but we let the tool run with
    // them missing and return a friendly error string. The 0.8b model recovers
    // from "I need both text and time" cleanly; it spirals when the schema
    // validator rejects with "invalid arguments for 'reminder_set'".
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description:
            "REQUIRED. What to remind the user about. Examples: 'take out the trash', 'call mom'. " +
            'Must be a non-empty string copied from the user message.',
        },
        time: {
          type: 'string',
          description:
            "REQUIRED. When to fire the reminder. Pass the user's phrase verbatim — the tool parses it. " +
            "Accepted: 'in 30 minutes', 'in 2 hours', 'at 3pm', '8pm', '20:00', 'tomorrow at 9am', or an ISO 8601 timestamp. " +
            'Must be a non-empty string.',
        },
      },
    },
    invoke: async (args, ctx) => {
      const a = args as { text?: string; time?: string };
      const text = a.text?.trim();
      const time = a.time?.trim();
      if (!text && !time) {
        return 'reminder_set needs both `text` (what to remind about) and `time` (when to fire). Re-call with both.';
      }
      if (!text)
        return 'reminder_set is missing `text` — what should the reminder say? Re-call with both `text` and `time`.';
      if (!time)
        return 'reminder_set is missing `time` — when should it fire? Re-call with both `text` and `time`.';
      const chatId = ctx.chatId ?? host.telegram.chatId;
      const fireAt = parseReminderTime(time);
      if (!fireAt) {
        return (
          `Could not parse time: "${time}".\n` +
          'Try: "in 30 minutes", "in 2 hours", "tomorrow at 9am", "at 3pm", "8pm", or an ISO date.'
        );
      }
      if (fireAt <= new Date()) return 'Reminder time is in the past.';
      host.db
        .prepare(`INSERT INTO reminders (chat_id, text, fire_at, created_at) VALUES (?,?,?,?)`)
        .run(chatId, text, fireAt.getTime(), Date.now());
      return `Reminder set for ${fireAt.toLocaleString()}: ${text}`;
    },
  });

  host.tools.register({
    name: 'reminder_list',
    intentPattern: REMINDER_LIST_INTENT,
    description:
      "List the user's upcoming (not-yet-fired) reminders. " +
      "Use when the user asks 'what reminders do I have', 'what's coming up'. " +
      'Do NOT use this to list calendar events (`calendar_list_events`) or todos (`tasks_list`).',
    tier: 'auto',
    parameters: { type: 'object', properties: {} },
    invoke: async (_args, ctx) => {
      const chatId = ctx.chatId ?? host.telegram.chatId;
      const rows = host.db
        .prepare(
          `SELECT id, chat_id, text, fire_at FROM reminders WHERE fired=0 AND chat_id=? ORDER BY fire_at LIMIT 20`,
        )
        .all(chatId) as ReminderRow[];
      if (rows.length === 0) return 'No upcoming reminders.';
      return rows
        .map((r) => `[${r.id}] ${new Date(r.fire_at).toLocaleString()}: ${r.text}`)
        .join('\n');
    },
  });

  host.tools.register({
    name: 'reminder_cancel',
    intentPattern: REMINDER_CANCEL_INTENT,
    description:
      'Cancel a pending reminder by its numeric id. ' +
      "Use when the user says 'cancel the reminder about X'. " +
      'Resolve the id from a prior `reminder_list` call — never invent one. Tier is `confirm`.',
    tier: 'confirm',
    parameters: {
      type: 'object',
      required: ['id'],
      properties: {
        id: {
          type: 'number',
          description: 'Reminder id from the `[N]` prefix in `reminder_list` output.',
        },
      },
    },
    invoke: async (args, ctx) => {
      const chatId = ctx.chatId ?? host.telegram.chatId;
      const { changes } = host.db
        .prepare(`DELETE FROM reminders WHERE id=? AND chat_id=? AND fired=0`)
        .run((args as { id: number }).id, chatId);
      return changes > 0 ? 'Reminder cancelled.' : 'Reminder not found or already fired.';
    },
  });
}

export { splitReminderArgs };
