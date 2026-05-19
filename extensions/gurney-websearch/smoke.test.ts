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

test('gurney-websearch: extension loads cleanly and registers web_search tool', async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const extensionsRoot = resolve(here, '..');
  const tmp = mkdtempSync(join(tmpdir(), 'gurney-websearch-smoke-'));
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

    const ext = loader.list().find((e) => e.name === 'gurney-websearch');
    assert.ok(ext, 'extension should appear in loader list');
    assert.equal(ext!.error, undefined, `load error: ${ext!.error ?? 'none'}`);
    assert.ok(tools.get('web_search'), 'web_search tool should be registered');

    // No Telegram commands registered (LLM-only tool per spec)
    const cmds = loader.commands().filter((c) => c.extension === 'gurney-websearch');
    assert.equal(cmds.length, 0);

    await loader.shutdown();
    db.close();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
