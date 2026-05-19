// Background extraction sweep. Runs on the configured cron tick, walks every
// conversation that has accumulated enough new messages since its last sync,
// and ships those messages to the bridge as episodes for fact extraction.
//
// PLAN: "Async memory store, never on the user-facing path." This is the
// async path — a cron job, not an inline orchestrator hook.

import type { DB } from '../../src/storage/db.js';
import type { Host } from '../../src/core/extensions.js';
import { getClient } from './helpers.js';
import type { MemoryEpisode } from './api.js';

interface MessageRow {
  id: number;
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  created_at: number;
}

export function register(host: Host): void {
  host.prompts.contribute(
    'You have access to long-term memory. When the user references a past detail you cannot see in the visible conversation, call `recall_memory` before guessing.',
  );

  const cron = String(host.settings.get<string>('extraction_cron', '*/15 * * * *'));
  host.scheduler.cron('memory-extraction-sweep', cron, async ({ log }) => {
    const c = getClient(host);
    if (!c) return [];
    const minBatch = Number(host.settings.get<number>('extraction_batch_size', 10));

    const conversations = host.db.prepare(`SELECT id FROM conversations`).all() as Array<{
      id: number;
    }>;

    let synced = 0;
    for (const { id: conversationId } of conversations) {
      const lastId = lastSyncedMessageId(host.db, conversationId);
      const fresh = host.db
        .prepare(
          `SELECT id, role, content, created_at FROM messages
           WHERE conversation_id = ? AND id > ? AND role IN ('user', 'assistant')
           ORDER BY id ASC`,
        )
        .all(conversationId, lastId) as MessageRow[];
      if (fresh.length < minBatch) continue;

      const episodes: MemoryEpisode[] = fresh.map((m) => ({
        text: m.content,
        created_at: m.created_at,
        role: m.role,
      }));
      try {
        const stored = await c.store(`conversation:${conversationId}`, episodes);
        const newest = fresh[fresh.length - 1]!.id;
        upsertSyncState(host.db, conversationId, newest);
        log.debug('memory extracted', { conversationId, episodes: episodes.length, stored });
        synced += 1;
      } catch (e) {
        log.warn('memory extraction failed', {
          conversationId,
          error: e instanceof Error ? e.message : String(e),
        });
        // Bail out of the sweep on the first bridge failure — a flapping
        // bridge shouldn't burn through every conversation in one tick.
        break;
      }
    }
    log.debug('memory sweep complete', { conversations_synced: synced });
    return [];
  });
}

function lastSyncedMessageId(db: DB, conversationId: number): number {
  const row = db
    .prepare(`SELECT last_message_id AS id FROM memgraph_sync_state WHERE conversation_id = ?`)
    .get(conversationId) as { id: number } | undefined;
  return row?.id ?? 0;
}

function upsertSyncState(db: DB, conversationId: number, lastMessageId: number): void {
  db.prepare(
    `INSERT INTO memgraph_sync_state (conversation_id, last_message_id, last_synced_at)
     VALUES (?, ?, ?)
     ON CONFLICT(conversation_id) DO UPDATE SET
       last_message_id = excluded.last_message_id,
       last_synced_at = excluded.last_synced_at`,
  ).run(conversationId, lastMessageId, Date.now());
}
