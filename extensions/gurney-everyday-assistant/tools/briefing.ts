// On-demand briefing tools — let the LLM call buildMorningBrief/buildNightBrief
// without waiting for the scheduled cron. Useful when the user says "give me
// my morning briefing" or "what does tomorrow look like" mid-day.

import type { Host } from '../../../src/core/extensions.js';
import { buildMorningBrief, buildNightBrief } from '../gather.js';

const TODAY_BRIEF_INTENT =
  '\\b(brief|briefing|morning brief|today|what.*today|what.*on today|day overview)\\b';
const TOMORROW_BRIEF_INTENT = '\\b(tomorrow|evening brief|night brief|what.*tomorrow)\\b';

export function register(host: Host): void {
  host.tools.register({
    name: 'briefing_today',
    intentPattern: TODAY_BRIEF_INTENT,
    description:
      "Generate today's briefing on demand: weather, calendar events, and tasks. " +
      "Use when the user says 'give me my morning briefing', 'what does today look like', 'brief me', 'what's on today'. " +
      'Prefer this over chaining three separate weather/calendar/tasks tool calls — it synthesises them in one formatted reply.',
    tier: 'auto',
    parameters: { type: 'object', properties: {} },
    invoke: async (_args, ctx) => buildMorningBrief(host, { signal: ctx.signal }),
  });

  host.tools.register({
    name: 'briefing_tomorrow',
    intentPattern: TOMORROW_BRIEF_INTENT,
    description:
      "Generate tomorrow's briefing on demand: tomorrow's calendar and outstanding tasks. " +
      "Use when the user says 'what does tomorrow look like', 'evening briefing', 'what's tomorrow'. " +
      'Prefer this over chaining calendar and tasks calls separately.',
    tier: 'auto',
    parameters: { type: 'object', properties: {} },
    invoke: async (_args, ctx) => buildNightBrief(host, { signal: ctx.signal }),
  });
}
