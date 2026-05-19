import type { DB } from '../../src/storage/db.js';
import type { Host } from '../../src/core/extensions.js';
import type { Nudge } from '../../src/core/scheduler.js';
import { matchesCron, parseCron } from '../../src/core/cron.js';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

interface CandidateInput {
  patternKey: string;
  kind: string;
  title: string;
  description: string;
  proposedCron: string;
  proposedText: string;
  confidence: number;
  evidence: Record<string, unknown>;
  sourceExtensions: string[];
}

interface CandidateRow {
  id: number;
  pattern_key: string;
  title: string;
  description: string;
  proposed_cron: string;
  proposed_text: string;
  confidence: number;
  evidence_json: string;
  source_extensions: string;
}

interface RuleRow {
  id: number;
  chat_id: number;
  title: string;
  cron: string;
  text: string;
  candidate_id: number | null;
}

interface UserHourRow {
  hour: number;
  n: number;
}

interface RepeatedReminderRow {
  text: string;
  hour: number;
  n: number;
  last_fire_at: number;
}

export function register(host: Host): void {
  host.prompts.contribute(
    'Routine suggestions are opt-in. If the user asks about routines, say Gurney learns only from local extension data and asks before creating recurring behavior.',
  );

  if (!settingsEnabled(host)) return;

  const suggestionCron = host.settings.get<string>('suggestion_cron', '30 8 * * *').trim();
  if (suggestionCron) {
    host.scheduler.cron('routine-suggestion-sweep', suggestionCron, async ({ firedAt, log }) => {
      const chatId = routineChatId(host);
      if (!chatId) return [];

      const candidates = discoverCandidates(
        host.db,
        firedAt,
        host.settings.get<number>('confidence_threshold', 0.7),
      );
      for (const candidate of candidates) upsertCandidate(host.db, candidate, firedAt.getTime());

      const autoAccept = host.settings.get<boolean>('auto_accept_suggestions', false);
      const pending = nextSuggestion(
        host.db,
        chatId,
        host.settings.get<number>('confidence_threshold', 0.7),
      );
      if (!pending) return [];

      if (autoAccept) {
        const ruleId = acceptCandidate(host.db, pending.id, chatId, firedAt.getTime());
        log.info('routine auto-accepted because setting is enabled', {
          candidateId: pending.id,
          ruleId,
        });
        return [];
      }

      if (
        sentTooManyThisWeek(
          host.db,
          chatId,
          host.settings.get<number>('max_suggestions_per_week', 3),
          firedAt.getTime(),
        )
      ) {
        return [];
      }

      const suggestionText = formatSuggestion(pending);
      const suggestionId = createSuggestion(
        host.db,
        pending.id,
        chatId,
        suggestionText,
        firedAt.getTime(),
      );
      markCandidateSuggested(host.db, pending.id, firedAt.getTime());
      log.info('routine suggestion queued', { candidateId: pending.id, suggestionId, chatId });
      return [
        {
          chatId,
          text: suggestionText,
          key: `routine-suggestion:${pending.id}:${suggestionId}`,
        },
      ];
    });
  }

  const deliveryCron = host.settings.get<string>('delivery_cron', '* * * * *').trim();
  if (deliveryCron) {
    host.scheduler.cron('routine-delivery-sweep', deliveryCron, async ({ firedAt }) => {
      if (!settingsEnabled(host)) return [];
      return dueRoutineNudges(host.db, firedAt);
    });
  }
}

export function discoverCandidates(db: DB, now: Date, threshold: number): CandidateInput[] {
  const out: CandidateInput[] = [];
  const installed = installedExtensions(db);

  // gurney-everyday-assistant bundles calendar, tasks, and reminders. Each
  // discovery function reads different tables/tool-call traces, so they stay
  // as separate blocks gated on the same extension.
  if (installed.has('gurney-everyday-assistant')) {
    const schedule = discoverNightScheduleCandidate(db, now, threshold);
    if (schedule) out.push(schedule);
  }

  if (installed.has('gurney-everyday-assistant') && tableExists(db, 'reminders')) {
    out.push(...discoverRepeatedReminderCandidates(db, now, threshold));
  }

  if (installed.has('gurney-everyday-assistant')) {
    const tasks = discoverTaskReviewCandidate(db, now, threshold);
    if (tasks) out.push(tasks);
  }

  // The memgraph extension currently stores sync bookkeeping locally and keeps
  // extracted facts in its bridge. Treat the local sync table as a safe signal
  // that memory exists, but do not mine bridge data or infer routines from it.
  if (installed.has('gurney-memgraph') && tableExists(db, 'memgraph_sync_state')) {
    recordRoutineEvent(
      db,
      null,
      null,
      0,
      'source_seen',
      'gurney-memgraph local sync state available',
      now.getTime(),
    );
  }

  return out;
}

export function dueRoutineNudges(db: DB, firedAt: Date): Nudge[] {
  const rows = db
    .prepare(
      `SELECT id, chat_id, title, cron, text, candidate_id FROM routine_rules WHERE status='active'`,
    )
    .all() as RuleRow[];
  const out: Nudge[] = [];
  const minute = Math.floor(firedAt.getTime() / 60_000) * 60_000;

  for (const row of rows) {
    let matches = false;
    try {
      matches = matchesCron(parseCron(row.cron), firedAt);
    } catch {
      recordRoutineEvent(
        db,
        row.id,
        row.candidate_id,
        row.chat_id,
        'invalid_cron',
        row.cron,
        firedAt.getTime(),
      );
      continue;
    }
    if (!matches || alreadyDelivered(db, row.id, minute)) continue;
    recordRoutineEvent(db, row.id, row.candidate_id, row.chat_id, 'delivered', row.title, minute);
    out.push({ chatId: row.chat_id, text: row.text, key: `routine:${row.id}:${minute}` });
  }

  return out;
}

function discoverNightScheduleCandidate(
  db: DB,
  now: Date,
  threshold: number,
): CandidateInput | null {
  const rows = db
    .prepare(
      `SELECT CAST(strftime('%H', datetime(m.created_at / 1000, 'unixepoch', 'localtime')) AS INTEGER) AS hour,
              COUNT(*) AS n
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       WHERE m.role='user'
         AND m.created_at >= ?
         AND (
           lower(m.content) GLOB '*tomorrow*schedule*'
           OR lower(m.content) GLOB '*schedule*tomorrow*'
           OR lower(m.content) GLOB '*tomorrow*calendar*'
         )
       GROUP BY hour
       ORDER BY n DESC, hour DESC
       LIMIT 1`,
    )
    .get(now.getTime() - 45 * DAY_MS) as UserHourRow | undefined;
  if (!rows || rows.n < 3) return null;

  const confidence = Math.min(0.95, 0.45 + rows.n * 0.1);
  if (confidence < threshold) return null;
  const deliveryHour = clampHour(rows.hour + 1);
  return {
    patternKey: `calendar:nightly-prep:${deliveryHour}`,
    kind: 'calendar_brief',
    title: 'Nightly prep brief',
    description: `You often ask for tomorrow's schedule around ${formatHour(rows.hour)}.`,
    proposedCron: `30 ${deliveryHour} * * *`,
    proposedText: "🌙 Nightly prep idea: ask me for tomorrow's schedule when you're ready.",
    confidence,
    evidence: { observations: rows.n, common_hour: rows.hour, window_days: 45 },
    sourceExtensions: ['gurney-everyday-assistant'],
  };
}

function discoverTaskReviewCandidate(db: DB, now: Date, threshold: number): CandidateInput | null {
  const rows = db
    .prepare(
      `SELECT CAST(strftime('%H', datetime(m.created_at / 1000, 'unixepoch', 'localtime')) AS INTEGER) AS hour,
              COUNT(*) AS n
       FROM messages m
       WHERE m.role='tool'
         AND m.tool_name IN ('tasks_list', 'tasks_add', 'tasks_complete')
         AND m.created_at >= ?
       GROUP BY hour
       ORDER BY n DESC, hour DESC
       LIMIT 1`,
    )
    .get(now.getTime() - 45 * DAY_MS) as UserHourRow | undefined;
  if (!rows || rows.n < 4) return null;

  const confidence = Math.min(0.9, 0.4 + rows.n * 0.08);
  if (confidence < threshold) return null;
  return {
    patternKey: `tasks:review:${rows.hour}`,
    kind: 'task_review',
    title: 'Task review prompt',
    description: `You often review or change tasks around ${formatHour(rows.hour)}.`,
    proposedCron: `0 ${rows.hour} * * 1-5`,
    proposedText: '✅ Task review: want to check your open tasks?',
    confidence,
    evidence: { observations: rows.n, common_hour: rows.hour, window_days: 45 },
    sourceExtensions: ['gurney-everyday-assistant'],
  };
}

function discoverRepeatedReminderCandidates(
  db: DB,
  now: Date,
  threshold: number,
): CandidateInput[] {
  const rows = db
    .prepare(
      `SELECT lower(trim(text)) AS text,
              CAST(strftime('%H', datetime(fire_at / 1000, 'unixepoch', 'localtime')) AS INTEGER) AS hour,
              COUNT(*) AS n,
              MAX(fire_at) AS last_fire_at
       FROM reminders
       WHERE created_at >= ?
       GROUP BY lower(trim(text)), hour
       HAVING COUNT(*) >= 3
       ORDER BY n DESC
       LIMIT 5`,
    )
    .all(now.getTime() - 90 * DAY_MS) as RepeatedReminderRow[];

  return rows.flatMap((row) => {
    const confidence = Math.min(0.9, 0.42 + row.n * 0.1);
    if (confidence < threshold) return [];
    const text = restoreReminderText(row.text);
    return [
      {
        patternKey: `reminder:repeat:${slug(row.text)}:${row.hour}`,
        kind: 'recurring_reminder',
        title: `Recurring reminder: ${text}`,
        description: `You've set "${text}" reminders ${row.n} times around ${formatHour(row.hour)}.`,
        proposedCron: `0 ${row.hour} * * *`,
        proposedText: `⏰ Routine reminder: ${text}`,
        confidence,
        evidence: {
          observations: row.n,
          common_hour: row.hour,
          last_fire_at: row.last_fire_at,
          window_days: 90,
        },
        sourceExtensions: ['gurney-everyday-assistant'],
      },
    ];
  });
}

function upsertCandidate(db: DB, c: CandidateInput, now: number): void {
  db.prepare(
    `INSERT INTO routine_candidates
       (pattern_key, kind, title, description, proposed_cron, proposed_text, confidence, evidence_json, source_extensions, first_seen_at, last_seen_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(pattern_key) DO UPDATE SET
       title=excluded.title,
       description=excluded.description,
       proposed_cron=excluded.proposed_cron,
       proposed_text=excluded.proposed_text,
       confidence=excluded.confidence,
       evidence_json=excluded.evidence_json,
       source_extensions=excluded.source_extensions,
       last_seen_at=excluded.last_seen_at,
       updated_at=excluded.updated_at,
       status=CASE WHEN routine_candidates.status IN ('dismissed', 'accepted', 'suggested') THEN routine_candidates.status ELSE 'candidate' END`,
  ).run(
    c.patternKey,
    c.kind,
    c.title,
    c.description,
    c.proposedCron,
    c.proposedText,
    c.confidence,
    JSON.stringify(c.evidence),
    c.sourceExtensions.join(','),
    now,
    now,
    now,
  );
}

function nextSuggestion(db: DB, chatId: number, threshold: number): CandidateRow | null {
  const row = db
    .prepare(
      `SELECT id, pattern_key, title, description, proposed_cron, proposed_text, confidence, evidence_json, source_extensions
       FROM routine_candidates
       WHERE status='candidate'
         AND confidence >= ?
         AND NOT EXISTS (
           SELECT 1 FROM routine_suggestions s
           WHERE s.candidate_id = routine_candidates.id
             AND s.chat_id = ?
             AND s.sent_at > ?
         )
       ORDER BY confidence DESC, updated_at DESC
       LIMIT 1`,
    )
    .get(threshold, chatId, Date.now() - 30 * DAY_MS) as CandidateRow | undefined;
  return row ?? null;
}

function formatSuggestion(row: CandidateRow): string {
  return (
    `💡 Routine suggestion #${row.id}\n` +
    `${row.description} Should I create this routine?\n\n` +
    `Proposed: ${row.title}\n` +
    `Schedule: ${row.proposed_cron}\n` +
    `Confidence: ${Math.round(row.confidence * 100)}%\n\n` +
    `Reply with /routine accept ${row.id}, or /routine why ${row.id}.`
  );
}

function createSuggestion(
  db: DB,
  candidateId: number,
  chatId: number,
  text: string,
  now: number,
): number {
  const info = db
    .prepare(
      `INSERT INTO routine_suggestions (candidate_id, chat_id, text, sent_at) VALUES (?, ?, ?, ?)`,
    )
    .run(candidateId, chatId, text, now);
  recordRoutineEvent(db, null, candidateId, chatId, 'suggested', text, now);
  return Number(info.lastInsertRowid);
}

function markCandidateSuggested(db: DB, candidateId: number, now: number): void {
  db.prepare(`UPDATE routine_candidates SET status='suggested', updated_at=? WHERE id=?`).run(
    now,
    candidateId,
  );
}

function acceptCandidate(db: DB, candidateId: number, chatId: number, now: number): number {
  const row = db
    .prepare(
      `SELECT title, proposed_cron, proposed_text, source_extensions FROM routine_candidates WHERE id=?`,
    )
    .get(candidateId) as
    | { title: string; proposed_cron: string; proposed_text: string; source_extensions: string }
    | undefined;
  if (!row) throw new Error(`routine candidate ${candidateId} not found`);
  const info = db
    .prepare(
      `INSERT INTO routine_rules (candidate_id, chat_id, title, cron, text, source_extensions, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      candidateId,
      chatId,
      row.title,
      row.proposed_cron,
      row.proposed_text,
      row.source_extensions,
      now,
      now,
    );
  const ruleId = Number(info.lastInsertRowid);
  db.prepare(`UPDATE routine_candidates SET status='accepted', updated_at=? WHERE id=?`).run(
    now,
    candidateId,
  );
  db.prepare(
    `UPDATE routine_suggestions SET status='accepted', responded_at=? WHERE candidate_id=? AND chat_id=? AND status='pending'`,
  ).run(now, candidateId, chatId);
  recordRoutineEvent(db, ruleId, candidateId, chatId, 'accepted', row.title, now);
  return ruleId;
}

function sentTooManyThisWeek(db: DB, chatId: number, max: number, now: number): boolean {
  if (max <= 0) return true;
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM routine_suggestions WHERE chat_id=? AND sent_at >= ?`)
    .get(chatId, now - WEEK_MS) as { n: number } | undefined;
  return (row?.n ?? 0) >= max;
}

function alreadyDelivered(db: DB, ruleId: number, minute: number): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS x FROM routine_events WHERE rule_id=? AND event_type='delivered' AND event_at=? LIMIT 1`,
    )
    .get(ruleId, minute) as { x: number } | undefined;
  return !!row;
}

function installedExtensions(db: DB): Set<string> {
  if (!tableExists(db, 'extension_state')) return new Set();
  const rows = db.prepare(`SELECT name FROM extension_state WHERE enabled=1`).all() as Array<{
    name: string;
  }>;
  return new Set(rows.map((r) => r.name));
}

function tableExists(db: DB, name: string): boolean {
  const row = db
    .prepare(`SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name=? LIMIT 1`)
    .get(name) as { x: number } | undefined;
  return !!row;
}

function recordRoutineEvent(
  db: DB,
  ruleId: number | null,
  candidateId: number | null,
  chatId: number,
  eventType: string,
  detail: string | null,
  eventAt: number,
): void {
  if (!tableExists(db, 'routine_events')) return;
  db.prepare(
    `INSERT INTO routine_events (rule_id, candidate_id, chat_id, event_type, detail, event_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(ruleId, candidateId, chatId, eventType, detail, eventAt);
}

function routineChatId(host: Host): number {
  const configured = Number(host.settings.get<number>('default_chat_id', 0));
  return configured || host.telegram.chatId;
}

function settingsEnabled(host: Host): boolean {
  return host.settings.get<boolean>('enabled', true);
}

function formatHour(hour: number): string {
  return new Date(2000, 0, 1, hour, 0).toLocaleTimeString(undefined, { hour: 'numeric' });
}

function clampHour(hour: number): number {
  return ((hour % 24) + 24) % 24;
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
}

function restoreReminderText(s: string): string {
  return s.length > 80 ? `${s.slice(0, 77)}...` : s;
}

export { acceptCandidate, formatSuggestion };
