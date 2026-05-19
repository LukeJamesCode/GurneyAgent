import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { open } from '../../src/storage/db.js';
import { createLogger } from '../../src/util/log.js';
import { createScheduler } from '../../src/core/scheduler.js';
import { createToolRegistry } from '../../src/core/tools.js';
import { createExtensionLoader } from '../../src/core/extensions.js';
import type { LLM, ProfileConfig, ProfileName } from '../../src/core/llm.js';

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

test('gurney-routines: extension loads, migrates schema, and registers management surfaces', async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const extensionsRoot = resolve(here, '..');
  const tmp = mkdtempSync(join(tmpdir(), 'gurney-routines-smoke-'));
  try {
    const db = open({ path: join(tmp, 'g.db') });
    const tools = createToolRegistry({ log });
    const sched = createScheduler({ log, db });
    const loader = createExtensionLoader({
      roots: [extensionsRoot],
      stateRoot: join(tmp, 'state'),
      db,
      llm: fakeLlm,
      log,
      scheduler: sched,
      tools,
      hostVersion: '0.1.0',
      chatId: 123,
      watch: false,
    });
    await loader.loadAll();

    const ext = loader.list().find((e) => e.name === 'gurney-routines');
    assert.ok(ext, 'extension should be in loader list');
    assert.equal(ext!.error, undefined, `load error: ${ext!.error ?? 'none'}`);

    assert.ok(tools.get('routine_list'), 'routine_list tool should be registered');

    const cmds = loader
      .commands()
      .filter((c) => c.extension === 'gurney-routines')
      .map((c) => c.name)
      .sort();
    assert.deepEqual(cmds, ['routine', 'routines']);

    const jobs = sched.list().filter((j) => j.extension === 'gurney-routines');
    assert.deepEqual(jobs.map((j) => j.name).sort(), [
      'routine-delivery-sweep',
      'routine-suggestion-sweep',
    ]);

    for (const table of [
      'routine_candidates',
      'routine_rules',
      'routine_suggestions',
      'routine_events',
    ]) {
      const row = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
        .get(table) as { name: string } | undefined;
      assert.ok(row, `${table} table should exist`);
    }

    const out = await tools.get('routine_list')!.invoke({}, { log, chatId: 123 });
    assert.match(out, /No routine suggestions/i);

    await loader.shutdown();
    db.close();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
