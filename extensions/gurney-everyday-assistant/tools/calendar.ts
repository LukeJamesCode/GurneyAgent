import type { Host } from '../../../src/core/extensions.js';
import { formatEventLine, getClient, hasClockTime, todayRangeIso } from '../helpers/calendar.js';
import { briefingTimeZone } from '../gather.js';

const NOT_CONFIGURED =
  'Google Calendar is not configured. Run `gurney auth gurney-everyday-assistant`.';

const CALENDAR_LIST_INTENT =
  '\\b(calendar|event|events|meeting|meetings|appointment|appointments|free|available|what.*scheduled|what.*on|do i have|am i free)\\b';
const CALENDAR_ADD_INTENT =
  '\\b(schedule|add|create|book|put).*(event|meeting|appointment|calendar)|\\b(event|meeting|appointment)\\b.*\\b(at|on|tomorrow|today|next|this|for)\\b';
const CALENDAR_DELETE_INTENT = '\\b(cancel|delete|remove).*(event|meeting|appointment|calendar)\\b';

export function register(host: Host): void {
  host.tools.register({
    name: 'calendar_list_events',
    intentPattern: CALENDAR_LIST_INTENT,
    description:
      'List Google Calendar EVENTS (appointments, meetings, time-blocked activities) for a day or date range. ' +
      "Use when the user asks 'what's on my calendar', 'what do I have today/tomorrow/this week', 'am I free at 3pm'. " +
      'Do NOT use this for tasks/todos — those live in `tasks_list`. ' +
      'Defaults to today if no range is given. ' +
      'For a SPECIFIC DATE the user named (e.g. "may 5th"), pass `time_min` as the start of that local day and `time_max` as the start of the next day — DO NOT widen the range to adjacent days. ' +
      'Each result line is prefixed with its own date — repeat that date back to the user verbatim. ' +
      'When you reply, list EVERY event from the result. Do not invent cancellations, reschedules, or status changes — the listing is read-only.',
    tier: 'auto',
    parameters: {
      type: 'object',
      properties: {
        time_min: {
          type: 'string',
          description:
            'ISO 8601 start of the range, inclusive (e.g. 2026-05-02T00:00:00-06:00). Omit to default to today.',
        },
        time_max: {
          type: 'string',
          description: 'ISO 8601 end of the range, exclusive. Omit to default to end-of-today.',
        },
        max: {
          type: 'number',
          description: 'Max events to return. Default 25. Bump up only for week/month views.',
        },
      },
    },
    invoke: async (args, ctx) => {
      const c = getClient(host, ctx.signal);
      if (!c) return NOT_CONFIGURED;
      const a = args as { time_min?: string; time_max?: string; max?: number };
      const parseBound = (s: string): Date | null => {
        const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
        if (dateOnly) {
          const [, y, m, d] = dateOnly;
          return new Date(Number(y), Number(m) - 1, Number(d));
        }
        const t = new Date(s);
        return Number.isNaN(t.getTime()) ? null : t;
      };
      let range: { timeMin: string; timeMax: string };
      if (a.time_min && a.time_max) {
        const s = parseBound(a.time_min);
        const e = parseBound(a.time_max);
        if (!s) return `Invalid time_min: ${a.time_min}`;
        if (!e) return `Invalid time_max: ${a.time_max}`;
        range = { timeMin: s.toISOString(), timeMax: e.toISOString() };
      } else if (a.time_min) {
        const start = parseBound(a.time_min);
        if (!start) return `Invalid time_min: ${a.time_min}`;
        const end = new Date(start);
        end.setDate(end.getDate() + 1);
        range = { timeMin: start.toISOString(), timeMax: end.toISOString() };
      } else if (a.time_max) {
        const end = parseBound(a.time_max);
        if (!end) return `Invalid time_max: ${a.time_max}`;
        const start = new Date(end);
        start.setDate(start.getDate() - 1);
        range = { timeMin: start.toISOString(), timeMax: end.toISOString() };
      } else {
        range = todayRangeIso(new Date(), briefingTimeZone(host));
      }
      const events = await c.listEvents({
        ...range,
        ...(a.max ? { max: a.max } : { max: 25 }),
      });
      if (events.length === 0) {
        return `No events between ${range.timeMin} and ${range.timeMax}.`;
      }
      const lines = events.map((ev) => formatEventLine(ev)).join('\n');
      const idMap = events.map((ev) => `${ev.summary}=${ev.id}`).join('; ');
      return (
        `${lines}\n\n` +
        `[internal — for tool calls only, never include in your reply to the user]\n` +
        `event_ids: ${idMap}`
      );
    },
  });

  host.tools.register({
    name: 'calendar_add_event',
    intentPattern: CALENDAR_ADD_INTENT,
    description:
      'Create a NEW Google Calendar event with structured start/end values. ' +
      'This is the DEFAULT calendar creation tool — use it for nearly all event-add requests, including timed events. ' +
      'Resolve the date and time yourself from the user phrase and pass them as ISO 8601 with the local timezone offset. ' +
      "Extract the event title as a clean noun phrase from the user's words (e.g. 'quiz for atomic physics' → 'Atomic Physics Quiz', 'lunch with Sam' → 'Lunch with Sam'). Do not append words the user did not say. " +
      'For all-day events, set `all_day: true`, pass YYYY-MM-DD dates, and treat `end` as the final calendar date the user wants included. ' +
      'Do NOT use this for tasks/todos (use `tasks_add`) or one-shot timed reminders (use `reminder_set`).',
    tier: 'auto',
    selfReplying: true,
    parameters: {
      type: 'object',
      required: ['summary', 'start', 'end'],
      properties: {
        summary: {
          type: 'string',
          description:
            "Event title. Use the user's own noun verbatim — do NOT append 'meeting', 'session', or 'appointment' that the user did not say.",
        },
        start: {
          type: 'string',
          description:
            'ISO 8601 start with timezone offset, e.g. 2026-05-01T13:00:00-06:00. Must be machine-parseable — if you only have a phrase, use `calendar_quick_add`.',
        },
        end: {
          type: 'string',
          description:
            'For timed events: ISO 8601 end with timezone offset. For all-day events: YYYY-MM-DD final included date.',
        },
        all_day: {
          type: 'boolean',
          description:
            'Set true when the user gives a date or date range without a clock time (graduations, trips, birthdays).',
        },
        description: {
          type: 'string',
          description: 'Optional event notes/description body.',
        },
      },
    },
    invoke: async (args, ctx) => {
      const c = getClient(host, ctx.signal);
      if (!c) return NOT_CONFIGURED;
      const a = args as {
        summary: string;
        start: string;
        end: string;
        all_day?: boolean;
        description?: string;
      };
      const allDay = a.all_day === true || isDateOnly(a.start) || isDateOnly(a.end);
      const ev = await c.addEvent({
        summary: a.summary,
        start: allDay ? toDateOnly(a.start) : a.start,
        end: allDay ? toDateOnly(a.end) : a.end,
        ...(allDay ? { allDay } : {}),
        ...(a.description ? { description: a.description } : {}),
      });
      return `Added: ${formatEventLine(ev)}`;
    },
  });

  host.tools.register({
    name: 'calendar_quick_add',
    intentPattern: CALENDAR_ADD_INTENT,
    description:
      "FALLBACK ONLY. Prefer `calendar_add_event` in almost every case — Google's natural-language parser mangles compound titles like 'quiz for atomic physics' (it produced 'Quiz at'). " +
      "Acceptable only for a very short, single-noun phrase with an explicit clock time, e.g. 'Lunch Friday 1pm', 'Gym at 6pm'. " +
      "If the user phrase contains 'for', 'about', 'with', a duration like '8 to 10am', or any complex structure, DO NOT use this tool — use `calendar_add_event` instead. " +
      "Also DO NOT use for date-only phrases like 'grad rehearsal on may 19th' — Google's parser silently drops the date.",
    tier: 'auto',
    selfReplying: true,
    parameters: {
      type: 'object',
      required: ['text'],
      properties: {
        text: {
          type: 'string',
          description:
            "Pass the user's phrase verbatim, including time. Must contain a clock time. Do NOT inject extra words like 'meeting' the user did not say.",
        },
      },
    },
    invoke: async (args, ctx) => {
      const c = getClient(host, ctx.signal);
      if (!c) return NOT_CONFIGURED;
      const text = (args as { text: string }).text;
      if (!hasClockTime(text)) {
        return (
          `"${text}" has no clock time, so Google's quick-add parser will silently drop the date and create the event on TODAY. ` +
          'Switch to `calendar_add_event` with `all_day: true`: resolve the date phrase against the current local date from the system prompt, ' +
          'then pass YYYY-MM-DD for both `start` and `end`.'
        );
      }
      const ev = await c.quickAdd(text);
      return `Added: ${formatEventLine(ev)}`;
    },
  });

  host.tools.register({
    name: 'calendar_delete_event',
    intentPattern: CALENDAR_DELETE_INTENT,
    description:
      'Delete a Google Calendar event by its id. ' +
      'Use after the user confirms cancellation. ' +
      'Get the id from a prior `calendar_list_events` call — never invent one. ' +
      'Tier is `confirm`, so the user is re-prompted before the delete fires.',
    tier: 'confirm',
    selfReplying: true,
    parameters: {
      type: 'object',
      required: ['id'],
      properties: {
        id: {
          type: 'string',
          description:
            'Google Calendar event id, taken from the trailing `event_ids:` block of a `calendar_list_events` result. Never invent or guess an id.',
        },
      },
    },
    invoke: async (args, ctx) => {
      const c = getClient(host, ctx.signal);
      if (!c) return NOT_CONFIGURED;
      await c.deleteEvent((args as { id: string }).id);
      return 'Deleted.';
    },
  });
}

function isDateOnly(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function toDateOnly(s: string): string {
  if (isDateOnly(s)) return s;
  const d = new Date(s);
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('-');
}
