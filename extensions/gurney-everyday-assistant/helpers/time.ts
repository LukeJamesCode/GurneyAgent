// Natural language time parser for reminders. Accepts:
//   - ISO 8601 datetime strings
//   - "in N minutes/hours/days"
//   - "tomorrow at H[:mm] [am|pm]"
//   - "at H[:mm] [am|pm]"  (today; rolls over to tomorrow if already past)

export function parseReminderTime(input: string, now: Date = new Date()): Date | null {
  const s = input.trim().toLowerCase();

  // ISO 8601 — must start with a digit and have a date separator
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const d = new Date(input);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  // "in N units"
  const inMatch = s.match(/^in (\d+)\s*(minutes?|hours?|days?)/);
  if (inMatch) {
    const n = parseInt(inMatch[1]!);
    const unit = inMatch[2]!;
    const d = new Date(now);
    if (unit.startsWith('min')) d.setMinutes(d.getMinutes() + n);
    else if (unit.startsWith('hour')) d.setHours(d.getHours() + n);
    else d.setDate(d.getDate() + n);
    return d;
  }

  // "tomorrow at H[:mm] [am|pm]"
  const tomMatch = s.match(/^tomorrow at (\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
  if (tomMatch) {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    d.setHours(
      resolveHour(parseInt(tomMatch[1]!), tomMatch[3] as 'am' | 'pm' | undefined),
      parseInt(tomMatch[2] ?? '0'),
      0,
      0,
    );
    return d;
  }

  // "at H[:mm] [am|pm]"
  const atMatch = s.match(/^(?:today )?at (\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
  if (atMatch) {
    const d = new Date(now);
    d.setHours(
      resolveHour(parseInt(atMatch[1]!), atMatch[3] as 'am' | 'pm' | undefined),
      parseInt(atMatch[2] ?? '0'),
      0,
      0,
    );
    // If already past, push to tomorrow
    if (d <= now) d.setDate(d.getDate() + 1);
    return d;
  }

  return null;
}

function resolveHour(h: number, ampm?: 'am' | 'pm'): number {
  if (ampm === 'pm' && h < 12) return h + 12;
  if (ampm === 'am' && h === 12) return 0;
  return h;
}

// Split a raw /remind arg string into { timeStr, message }.
// Examples:
//   "in 30 minutes Call doctor"  → { timeStr: "in 30 minutes", message: "Call doctor" }
//   "tomorrow at 9am Stand-up"   → { timeStr: "tomorrow at 9am", message: "Stand-up" }
//   "at 3pm Review PR"           → { timeStr: "at 3pm", message: "Review PR" }
export function splitReminderArgs(input: string): { timeStr: string; message: string } | null {
  const s = input.trim();

  const patterns: RegExp[] = [
    /^(in \d+\s*(?:minutes?|hours?|days?))\s+(.+)/i,
    /^(tomorrow at \d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s+(.+)/i,
    /^((?:today )?at \d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s+(.+)/i,
    /^(\d{4}-\d{2}-\d{2}(?:T[\d:]+)?(?:Z|[+-]\d{2}:\d{2})?)\s+(.+)/i,
  ];

  for (const pat of patterns) {
    const m = s.match(pat);
    if (m) return { timeStr: m[1]!.trim(), message: m[2]!.trim() };
  }
  return null;
}
