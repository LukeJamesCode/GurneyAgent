import type { Host } from '../../../src/core/extensions.js';
import { formatEventLine, getClient, hasClockTime, todayRangeIso } from '../helpers/calendar.js';
import { briefingTimeZone } from '../gather.js';

const NOT_CONFIGURED =
  'Google Calendar is not configured. Run `gurney auth gurney-everyday-assistant`.';

const CALENDAR_LIST_INTENT =
  '\\b(calendar|event|events|meeting|meetings|appointment|appointments|free|available|what.*scheduled|what.*on|do i have|am i free)\\b';
const CALENDAR_ADD_INTENT =
  '\\b(schedule|add|create|book|put).*(event|meeting|appointment|calendar)' +
  '|\\b(event|meeting|appointment)\\b.*\\b(at|on|tomorrow|today|next|this|for)\\b' +
  '|\\b(add|schedule|book|put|create)\\b.*\\b(\\d{1,2}(:\\d{2})?\\s*(am|pm)|\\d{1,2}\\s*(am|pm)|\\d{1,2}:\\d{2})\\b';
const CALENDAR_DELETE_INTENT = '\\b(cancel|delete|remove).*(event|meeting|appointment|calendar)\\b';

export function register(host: Host): void {
  host.tools.register({
    name: 'calendar_list_events',
    intentPattern: CALENDAR_LIST_INTENT,
    description:
      "List Google Calendar events for a day or range. ALWAYS call for 'do I have anything tomorrow / am I free at 3pm / what's on my calendar / show my events this week'. " +
      "Defaults to today. For a specific date the user named, set `time_min` to the start of that local day and `time_max` to the start of the next — do not widen. " +
      "Read-only: list every event in the result, repeat each line's date verbatim, never claim an event is cancelled.",
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
      return `${lines}\nevent_ids: ${idMap}`;
    },
  });

  host.tools.register({
    name: 'calendar_add_event',
    intentPattern: CALENDAR_ADD_INTENT,
    description:
      "Create a Google Calendar event with structured start/end. DEFAULT for any event-add request, including dentist/doctor/haircut/DMV/school appointments (you record on the user's calendar, you don't book with the provider). " +
      "Resolve the date yourself from the system prompt's current date; default morning=09:00, afternoon=14:00, evening=18:00 when no clock time. Title = user's noun phrase verbatim. " +
      "For all-day events: `all_day: true`, YYYY-MM-DD start/end, `end` = final included date.",
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
      "FALLBACK only. Google's NL parser mangles anything beyond a single-noun event with an explicit clock time on a SPECIFIC named weekday ('Lunch Friday 1pm', 'Gym Saturday 6pm'). " +
      "Skip — use `calendar_add_event` instead — if the phrase has ANY of: 'for/about/with', a duration ('6:30am to 7:30am'), the words 'appointment/session/meeting', the relative-day words 'tomorrow/today/tonight/next/this', a time-of-day word ('morning/afternoon/evening'), or no clock time at all. " +
      "When in doubt: use `calendar_add_event`. quick_add is the wrong default.",
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
      "Cancel/delete a calendar event the user named ('cancel the camping event', 'remove tomorrow's 3pm'). " +
      "If you don't have the id yet, call `calendar_list_events` first in this turn and read the id from the `event_ids:` line — then CALL THIS TOOL with that id. Do not stop after listing. " +
      "Never invent an id, never report a fake id-shaped string as the event id, never say the event doesn't exist without listing first.",
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
