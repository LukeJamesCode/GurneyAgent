import type { DB } from '../../src/storage/db.js';
import type { Host, TelegramCommandContext } from '../../src/core/extensions.js';
import { acceptCandidate } from './jobs.js';

interface SuggestionRow {
  id: number;
  candidate_id: number;
  title: string;
  description: string;
  proposed_cron: string;
  confidence: number;
  status: string;
}

interface RuleRow {
  id: number;
  title: string;
  cron: string;
  status: string;
}

interface CandidateWhyRow {
  id: number;
  title: string;
  description: string;
  proposed_cron: string;
  confidence: number;
  evidence_json: string;
  source_extensions: string;
  status: string;
}

export function register(host: Host): void {
  host.telegram.command('routines', async (ctx) => listRoutines(host, ctx), 'List routines');

  host.telegram.command(
    'routine',
    async (ctx) => {
      const [verb, idText] = ctx.args.trim().split(/\s+/, 2);
      const id = Number(idText);
      if (!verb || !['accept', 'pause', 'delete', 'why'].includes(verb) || !Number.isInteger(id)) {
        await ctx.reply(
          'Usage:\n' +
            '  /routine accept <suggestion-id>\n' +
            '  /routine pause <routine-id>\n' +
            '  /routine delete <routine-id>\n' +
            '  /routine why <suggestion-id>',
        );
        return;
      }

      if (verb === 'accept') await acceptRoutine(host, ctx, id);
      if (verb === 'pause') await pauseRoutine(host, ctx, id);
      if (verb === 'delete') await deleteRoutine(host, ctx, id);
      if (verb === 'why') await explainRoutine(host, ctx, id);
    },
    'Manage routines: accept, pause, delete, why',
  );
}

async function listRoutines(host: Host, ctx: TelegramCommandContext): Promise<void> {
  const suggestions = host.db
    .prepare(
      `SELECT c.id, s.candidate_id, c.title, c.description, c.proposed_cron, c.confidence, s.status
       FROM routine_suggestions s
       JOIN routine_candidates c ON c.id = s.candidate_id
       WHERE s.chat_id=? AND s.status='pending'
       ORDER BY s.sent_at DESC
       LIMIT 10`,
    )
    .all(ctx.chatId) as SuggestionRow[];

  const rules = host.db
    .prepare(
      `SELECT id, title, cron, status FROM routine_rules WHERE chat_id=? AND status!='deleted' ORDER BY id`,
    )
    .all(ctx.chatId) as RuleRow[];

  const parts: string[] = [];
  if (suggestions.length > 0) {
    parts.push(
      'Pending suggestions:\n' +
        suggestions
          .map(
            (s) =>
              `#${s.candidate_id} ${s.title} — ${Math.round(s.confidence * 100)}% (${s.proposed_cron})`,
          )
          .join('\n'),
    );
  }
  if (rules.length > 0) {
    parts.push(
      'Routines:\n' + rules.map((r) => `#${r.id} ${r.title} — ${r.status} (${r.cron})`).join('\n'),
    );
  }

  await ctx.reply(
    parts.length > 0 ? parts.join('\n\n') : 'No routine suggestions or active routines yet.',
  );
}

async function acceptRoutine(
  host: Host,
  ctx: TelegramCommandContext,
  candidateId: number,
): Promise<void> {
  const candidate = candidateById(host.db, candidateId);
  if (!candidate) {
    await ctx.reply(`No routine suggestion found for #${candidateId}.`);
    return;
  }
  if (candidate.status === 'accepted') {
    await ctx.reply(`Routine suggestion #${candidateId} has already been accepted.`);
    return;
  }

  const ruleId = acceptCandidate(host.db, candidateId, ctx.chatId, Date.now());
  await ctx.reply(
    `Created routine #${ruleId}: ${candidate.title}\nSchedule: ${candidate.proposed_cron}`,
  );
}

async function pauseRoutine(
  host: Host,
  ctx: TelegramCommandContext,
  ruleId: number,
): Promise<void> {
  const changes = updateRuleStatus(host.db, ctx.chatId, ruleId, 'paused');
  await ctx.reply(
    changes > 0 ? `Paused routine #${ruleId}.` : `No active routine found for #${ruleId}.`,
  );
}

async function deleteRoutine(
  host: Host,
  ctx: TelegramCommandContext,
  ruleId: number,
): Promise<void> {
  const changes = updateRuleStatus(host.db, ctx.chatId, ruleId, 'deleted');
  await ctx.reply(changes > 0 ? `Deleted routine #${ruleId}.` : `No routine found for #${ruleId}.`);
}

async function explainRoutine(
  host: Host,
  ctx: TelegramCommandContext,
  candidateId: number,
): Promise<void> {
  const row = candidateById(host.db, candidateId);
  if (!row) {
    await ctx.reply(`No routine suggestion found for #${candidateId}.`);
    return;
  }

  let evidence = row.evidence_json;
  try {
    const parsed = JSON.parse(row.evidence_json) as Record<string, unknown>;
    evidence = Object.entries(parsed)
      .map(([k, v]) => `${k}: ${String(v)}`)
      .join(', ');
  } catch {
    // Leave raw evidence string.
  }

  await ctx.reply(
    `Why #${row.id}: ${row.title}\n` +
      `${row.description}\n` +
      `Schedule: ${row.proposed_cron}\n` +
      `Confidence: ${Math.round(row.confidence * 100)}%\n` +
      `Sources: ${row.source_extensions}\n` +
      `Evidence: ${evidence}`,
  );
}

function candidateById(db: DB, id: number): CandidateWhyRow | null {
  const row = db
    .prepare(
      `SELECT id, title, description, proposed_cron, confidence, evidence_json, source_extensions, status
       FROM routine_candidates WHERE id=?`,
    )
    .get(id) as CandidateWhyRow | undefined;
  return row ?? null;
}

function updateRuleStatus(
  db: DB,
  chatId: number,
  ruleId: number,
  status: 'paused' | 'deleted',
): number {
  const result = db
    .prepare(
      `UPDATE routine_rules SET status=?, updated_at=? WHERE id=? AND chat_id=? AND status!='deleted'`,
    )
    .run(status, Date.now(), ruleId, chatId);
  db.prepare(
    `INSERT INTO routine_events (rule_id, candidate_id, chat_id, event_type, detail, event_at)
     SELECT id, candidate_id, chat_id, ?, ?, ? FROM routine_rules WHERE id=? AND chat_id=?`,
  ).run(status, null, Date.now(), ruleId, chatId);
  return result.changes;
}
