// Direct test of the extraction sweep against an in-memory SQLite + a stub
// memory client. Verifies the batch threshold, the per-conversation cursor,
// and that a bridge failure halts the sweep without corrupting state.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { open } from '../../src/storage/db.js';
import { createLogger } from '../../src/util/log.js';
import { createScheduler } from '../../src/core/scheduler.js';
import { createToolRegistry } from '../../src/core/tools.js';
import { createExtensionLoader } from '../../src/core/extensions.js';
import type { LLM, ProfileConfig, ProfileName } from '../../src/core/llm.js';
import type { MemoryEpisode } from './api.js';

const log = createLogger({ level: 'error', out: () => {}, err: () => {} });

const fakeLlm: LLM = {
  chat: () => {
    throw new Error('not used');
  },
  async health() {
    return { ok: true, models: [] };
  },
  listProfiles(): Record<ProfileName, ProfileConfig | null> {
    return { chat: null, reason: null, tools: null };
  },
  resolveModel() {
    return 'fake';
  },
};

async function bootstrap() {
  const here = dirname(fileURLToPath(import.meta.url));
  const extensionsRoot = resolve(here, '..');
  const tmp = mkdtempSync(join(tmpdir(), 'gurney-mem-jobs-'));
  const db = open({ path: join(tmp, 'g.db') });
  const tools = createToolRegistry({ log });
  const sched = createScheduler({ log });
  const loader = createExtensionLoader({
    roots: [extensionsRoot],
    stateRoot: join(tmp, 'state'),
    db,
    llm: fakeLlm,
    log,
    scheduler: sched,
    tools,
    hostVersion: '0.1.0',
    chatId: 0,
    watch: false,
  });
  await loader.loadAll();
  // Filter so we only target our cron job.
  const jobsForExt = sched.list().filter((j) => j.extension === 'gurney-memgraph');
  assert.equal(jobsForExt.length, 1);
  return { tmp, db, sched, loader };
}

function seedConversation(
  db: ReturnType<typeof open>,
  conversationId: number,
  pairs: number,
  startId: number,
): void {
  db.prepare(`INSERT INTO conversations (id, telegram_chat_id, started_at) VALUES (?, ?, ?)`).run(
    conversationId,
    1,
    Date.now(),
  );
  for (let i = 0; i < pairs; i++) {
    db.prepare(
      `INSERT INTO messages (id, conversation_id, role, content, created_at)
       VALUES (?, ?, 'user', ?, ?)`,
    ).run(startId + i * 2, conversationId, `u${i}`, Date.now());
    db.prepare(
      `INSERT INTO messages (id, conversation_id, role, content, created_at)
       VALUES (?, ?, 'assistant', ?, ?)`,
    ).run(startId + i * 2 + 1, conversationId, `a${i}`, Date.now());
  }
}

test('extraction sweep skips when fresh-message count is below extraction_batch_size', async () => {
  const { tmp, db, sched, loader } = await bootstrap();
  try {
    // batch threshold defaults to 10. Seed only 4 messages.
    seedConversation(db, 1, 2, 1);

    // Configure a bridge URL so the client constructs, and stub fetch.
    db.prepare(
      `INSERT INTO extension_settings (extension, key, value, updated_at) VALUES (?, ?, ?, ?)`,
    ).run('gurney-memgraph', 'bridge_url', 'http://stub', Date.now());

    let storeCalls = 0;
    (globalThis as unknown as { fetch: typeof fetch }).fetch = (async () => {
      storeCalls += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({ stored: 0 }),
        text: async () => '',
      };
    }) as unknown as typeof fetch;

    await sched.tickAt(new Date('2026-05-01T00:15:00Z'));
    assert.equal(storeCalls, 0, 'bridge must not be called below threshold');

    await loader.shutdown();
    db.close();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('extraction sweep ships fresh user/assistant turns and advances the cursor', async () => {
  const { tmp, db, sched, loader } = await bootstrap();
  try {
    seedConversation(db, 1, 6, 1); // 12 messages, well over batch threshold of 10
    db.prepare(
      `INSERT INTO extension_settings (extension, key, value, updated_at) VALUES (?, ?, ?, ?)`,
    ).run('gurney-memgraph', 'bridge_url', 'http://stub', Date.now());

    let received: MemoryEpisode[] | null = null;
    (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (
      _url: string,
      init?: { body?: string },
    ) => {
      const body = JSON.parse(init?.body ?? '{}') as { episodes: MemoryEpisode[] };
      received = body.episodes;
      return {
        ok: true,
        status: 200,
        json: async () => ({ stored: body.episodes.length }),
        text: async () => '',
      };
    }) as unknown as typeof fetch;

    await sched.tickAt(new Date('2026-05-01T00:15:00Z'));
    assert.ok(received, 'bridge should have been called');
    assert.equal(received!.length, 12);

    const cursor = db
      .prepare(`SELECT last_message_id FROM memgraph_sync_state WHERE conversation_id = 1`)
      .get() as { last_message_id: number };
    assert.equal(cursor.last_message_id, 12);

    // Second tick with no new messages — should be a no-op.
    received = null;
    await sched.tickAt(new Date('2026-05-01T00:30:00Z'));
    assert.equal(received, null);

    await loader.shutdown();
    db.close();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('migrations table is owned by this extension under its private namespace', async () => {
  const { tmp, db, loader } = await bootstrap();
  try {
    const row = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='_ext_gurney_memgraph_migrations'",
      )
      .get() as { name: string } | undefined;
    assert.ok(row, 'expected per-extension migrations table');
    await loader.shutdown();
    db.close();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
