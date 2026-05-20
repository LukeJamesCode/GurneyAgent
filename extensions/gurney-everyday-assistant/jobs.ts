// All cron jobs for gurney-everyday-assistant:
//   1. event-reminder-sweep  — nudge 15min before calendar events
//   2. reminder-sweep        — fire one-shot reminders from the reminders table
//   3. morning-briefing      — scheduled morning brief
//   4. night-briefing        — scheduled evening brief
//   5. weather-reschedule-sweep — flag outdoor events when forecast worsens

import type { DB } from '../../src/storage/db.js';
import type { Host } from '../../src/core/extensions.js';
import type { Nudge } from '../../src/core/scheduler.js';
import { getClient as getCalClient } from './helpers/calendar.js';
import { buildMorningBrief, buildNightBrief, briefingTimeZone } from './gather.js';
import { weatherRescheduleCheckNudges } from './tools/planning.js';

interface ReminderRow {
  id: number;
  chat_id: number;
  text: string;
}

export function register(host: Host): void {
  host.prompts.contribute(
    'When the user asks about their schedule, prefer calling `calendar_list_events` over guessing.',
  );

  // ── 1. Event reminder sweep ─────────────────────────────────────────────────

  host.scheduler.cron('event-reminder-sweep', '*/5 * * * *', async ({ firedAt, log }) => {
    const c = getCalClient(host);
    if (!c) return [];
    const chatIds = targetNudgeChatIds(host);
    if (chatIds.length === 0) return [];
    const lookahead = Number(host.settings.get<number>('nudge_lookahead_minutes', 15));
    if (!Number.isFinite(lookahead) || lookahead <= 0) {
      log.warn('invalid nudge_lookahead_minutes; skipping event-reminder sweep', { lookahead });
      return [];
    }

    const now = firedAt;
    const horizon = new Date(now.getTime() + lookahead * 60_000);
    let events: Awaited<ReturnType<typeof c.listEvents>>;
    try {
      events = await c.listEvents({
        timeMin: now.toISOString(),
        timeMax: horizon.toISOString(),
      });
    } catch (e) {
      log.warn('calendar list failed during sweep', {
        error: e instanceof Error ? e.message : String(e),
      });
      return [];
    }

    const out: Nudge[] = [];
    for (const ev of events) {
      const startMs = new Date(ev.start).getTime();
      if (startMs < now.getTime()) continue;
      const fireMinute = Math.floor(startMs / 60_000);
      const minsAway = Math.max(0, Math.round((startMs - now.getTime()) / 60_000));
      for (const chatId of chatIds) {
        if (alreadySent(host.db, ev.id, fireMinute, chatId)) continue;
        out.push({
          chatId,
          text: `🗓 In ${minsAway}m: ${ev.summary}`,
          key: `cal:${chatId}:${ev.id}:${fireMinute}`,
          category: 'calendar',
          priority: 'normal',
          reason: 'Calendar event is starting soon',
          source: 'gurney-everyday-assistant',
          createdAt: firedAt,
          expiresAt: new Date(startMs + 30 * 60_000),
          defer: true,
        });
      }
    }
    return out;
  });

  // ── 2. Reminder sweep ───────────────────────────────────────────────────────

  host.scheduler.cron('reminder-sweep', '* * * * *', async ({ firedAt, log }) => {
    const now = firedAt.getTime();
    const rows = host.db
      .prepare(`SELECT id, chat_id, text FROM reminders WHERE fired=0 AND fire_at<=?`)
      .all(now) as ReminderRow[];

    if (rows.length === 0) return [];

    const nudges: Nudge[] = [];
    for (const row of rows) {
      host.db.prepare(`UPDATE reminders SET fired=1 WHERE id=?`).run(row.id);
      nudges.push({
        chatId: row.chat_id,
        text: `⏰ Reminder: ${row.text}`,
        key: `reminder:${row.id}`,
        category: 'reminder',
        priority: 'high',
        reason: 'Reminder reached its scheduled fire time',
        source: 'gurney-everyday-assistant',
        createdAt: firedAt,
        defer: true,
      });
      log.debug('reminder fired', { id: row.id, chatId: row.chat_id });
    }
    return nudges;
  });

  // ── 3 & 4. Morning and night briefings ─────────────────────────────────────

  const morningCron = briefingCron(host, 'morning', '07:00', '1-5');
  const nightCron = briefingCron(host, 'night', '21:00', '*');
  const timeZone = briefingTimeZone(host);
  const schedulerOpts = timeZone ? { timeZone } : undefined;

  if (morningCron?.trim()) {
    host.scheduler.cron(
      'morning-briefing',
      morningCron,
      async ({ log, firedAt }) => {
        const chatIds = targetBriefingChatIds(host);
        if (chatIds.length === 0) return [];
        log.debug('sending morning briefing', { chatIds });
        try {
          const text = await buildMorningBrief(host);
          const day = firedAt.toLocaleDateString('sv', { ...(timeZone ? { timeZone } : {}) });
          return chatIds.map((chatId) => ({
            chatId,
            text,
            key: `morning-brief:${chatId}:${day}`,
            category: 'briefing',
            priority: 'normal',
            reason: 'Scheduled morning briefing',
            source: 'gurney-everyday-assistant',
            createdAt: firedAt,
            defer: true,
          }));
        } catch (e) {
          log.warn('morning briefing failed', {
            error: e instanceof Error ? e.message : String(e),
          });
          return [];
        }
      },
      schedulerOpts,
    );
  }

  if (nightCron?.trim()) {
    host.scheduler.cron(
      'night-briefing',
      nightCron,
      async ({ log, firedAt }) => {
        const chatIds = targetBriefingChatIds(host);
        if (chatIds.length === 0) return [];
        log.debug('sending night briefing', { chatIds });
        try {
          const text = await buildNightBrief(host);
          const day = firedAt.toLocaleDateString('sv', { ...(timeZone ? { timeZone } : {}) });
          return chatIds.map((chatId) => ({
            chatId,
            text,
            key: `night-brief:${chatId}:${day}`,
            category: 'briefing',
            priority: 'normal',
            reason: 'Scheduled evening briefing',
            source: 'gurney-everyday-assistant',
            createdAt: firedAt,
            defer: true,
          }));
        } catch (e) {
          log.warn('night briefing failed', { error: e instanceof Error ? e.message : String(e) });
          return [];
        }
      },
      schedulerOpts,
    );
  }

  // ── 5. Weather reschedule sweep ─────────────────────────────────────────────

  const weatherCrons = weatherRescheduleCrons(host);
  weatherCrons.forEach((cron, idx) => {
    const name = weatherCrons.length === 1
      ? 'weather-reschedule-sweep'
      : `weather-reschedule-sweep-${idx + 1}`;
    host.scheduler.cron(name, cron, async ({ log }) => {
      try {
        return await weatherRescheduleCheckNudges(host);
      } catch (e) {
        log.warn('weather reschedule sweep failed', {
          error: e instanceof Error ? e.message : String(e),
        });
        return [];
      }
    });
  });
}

function weatherRescheduleCrons(host: Host): string[] {
  const legacy = host.settings.get<string>('weather_reschedule_cron');
  if (legacy?.trim()) return [legacy.trim()];
  const times = host.settings.get<string>('weather_reschedule_times', '06:00,18:00');
  if (!times?.trim()) return [];
  const crons: string[] = [];
  for (const piece of times.split(',')) {
    const cron = timeToCron(piece, '*');
    if (cron) crons.push(cron);
  }
  return crons;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function targetNudgeChatIds(host: Host): number[] {
  const configured = Number(host.settings.get<number | string>('nudge_chat_id', 0));
  if (Number.isFinite(configured) && configured !== 0) return [configured];
  return host.telegram.defaultChatId ? [host.telegram.defaultChatId] : [];
}

function targetBriefingChatIds(host: Host): number[] {
  const configured = Number(host.settings.get<number | string>('briefing_chat_id', 0));
  if (Number.isFinite(configured) && configured !== 0) return [configured];
  return host.telegram.defaultChatId ? [host.telegram.defaultChatId] : [];
}

export function briefingCron(
  host: Host,
  kind: 'morning' | 'night',
  defaultTime: string,
  days: string,
): string | null {
  const timeKey = `${kind}_time`;
  const legacyKey = `${kind}_cron`;
  const configuredTime = host.settings.get<string>(timeKey, defaultTime);
  const legacyCron = host.settings.get<string>(legacyKey);
  if (legacyCron?.trim() && configuredTime === defaultTime) return legacyCron.trim();
  return timeToCron(configuredTime, days);
}

export function timeToCron(time: string, days: string): string | null {
  if (!time.trim()) return null;
  const parsed = parseHHMM(time);
  if (!parsed) return null;
  const [h, m] = parsed;
  return `${m} ${h} * * ${days}`;
}

function parseHHMM(time: string): [number, number] | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return [hour, minute];
}

function alreadySent(db: DB, eventId: string, fireMinute: number, chatId: number): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS x FROM calendar_nudges_sent
       WHERE event_id = ? AND fire_minute = ? AND chat_id IN (?, 0)`,
    )
    .get(eventId, fireMinute, chatId) as { x: number } | undefined;
  return !!row;
}
