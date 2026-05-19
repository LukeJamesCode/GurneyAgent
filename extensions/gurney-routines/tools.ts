import type { Host } from '../../src/core/extensions.js';

interface CandidateRow {
  id: number;
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

export function register(host: Host): void {
  host.tools.register({
    name: 'routine_list',
    description:
      'List routine suggestions and accepted routines. Use when the user asks what routines Gurney has learned or configured.',
    tier: 'auto',
    parameters: { type: 'object', properties: {} },
    invoke: async (_args, ctx) => {
      const chatId = ctx.chatId ?? host.telegram.chatId;
      const candidates = host.db
        .prepare(
          `SELECT id, title, description, proposed_cron, confidence, status
           FROM routine_candidates
           WHERE status IN ('candidate', 'suggested')
           ORDER BY confidence DESC, updated_at DESC
           LIMIT 10`,
        )
        .all() as CandidateRow[];
      const rules = host.db
        .prepare(
          `SELECT id, title, cron, status FROM routine_rules WHERE chat_id=? AND status!='deleted' ORDER BY id`,
        )
        .all(chatId) as RuleRow[];

      const parts: string[] = [];
      if (candidates.length > 0) {
        parts.push(
          'Suggestions:\n' +
            candidates
              .map(
                (c) =>
                  `#${c.id} ${c.title} — ${c.status}, ${Math.round(c.confidence * 100)}%, ${c.proposed_cron}`,
              )
              .join('\n'),
        );
      }
      if (rules.length > 0) {
        parts.push(
          'Rules:\n' + rules.map((r) => `#${r.id} ${r.title} — ${r.status}, ${r.cron}`).join('\n'),
        );
      }
      return parts.length > 0 ? parts.join('\n\n') : 'No routine suggestions or rules yet.';
    },
  });
}
