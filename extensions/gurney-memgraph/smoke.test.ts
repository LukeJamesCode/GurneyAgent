// Smoke test: load the real extension folder and confirm every advertised
// hook actually registered. Mirrors gurney-google-calendar/smoke.test.ts.

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

test('gurney-memgraph: real extension folder loads cleanly via the loader', async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const extensionsRoot = resolve(here, '..');
  const tmp = mkdtempSync(join(tmpdir(), 'gurney-mem-smoke-'));
  try {
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

    const exts = loader.list();
    const mem = exts.find((e) => e.name === 'gurney-memgraph');
    assert.ok(mem, 'extension should appear in the loader list');
    assert.equal(mem!.error, undefined, `extension load error: ${mem!.error ?? 'none'}`);

    for (const t of ['recall_memory', 'store_memory']) {
      assert.ok(tools.get(t), `expected tool ${t} to be registered`);
    }

    const cmds = loader.commands().filter((c) => c.extension === 'gurney-memgraph');
    const cmdNames = cmds.map((c) => c.name).sort();
    assert.deepEqual(cmdNames, ['forget', 'memory', 'remember']);

    const jobs = sched.list().filter((j) => j.extension === 'gurney-memgraph');
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]!.name, 'memory-extraction-sweep');

    // Per-extension migration must have created the bookkeeping table.
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memgraph_sync_state'")
      .get() as { name: string } | undefined;
    assert.ok(row, 'expected memgraph_sync_state table');

    // Tools degrade gracefully when the bridge is unreachable. The default
    // bridge_url points at localhost:8765 so the call attempts a real fetch
    // and surfaces the failure as a string rather than an unhandled throw.
    const out = await tools.get('recall_memory')!.invoke({ query: 'anything' }, { log });
    assert.match(out, /Memory recall failed|not configured/i);

    await loader.shutdown();
    db.close();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
