import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';

import { open } from '../../src/storage/db.js';

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

test('frontend API creates agents through POST /api/agents', async () => {
  const previousHome = process.env['GURNEY_HOME'];
  const home = mkdtempSync(join(tmpdir(), 'gurney-frontend-agents-'));
  const port = await freePort();

  process.env['GURNEY_HOME'] = home;
  const db = open({ path: join(home, 'gurney.db') });
  try {
    const now = Date.now();
    const saveSetting = db.prepare(
      `INSERT INTO extension_settings (extension, key, value, updated_at) VALUES (?, ?, ?, ?)`,
    );
    saveSetting.run('gurney-frontend', 'https_enabled', 'false', now);
    saveSetting.run('gurney-frontend', 'listen_host', '127.0.0.1', now);
    saveSetting.run('gurney-frontend', 'listen_port', String(port), now);
  } finally {
    db.close();
  }

  const { run } = await import('./server.js');
  const server = await run();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/agents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'planner',
        role: 'plans the work',
        systemPrompt: 'You break goals into practical next steps.',
        profile: 'reason',
        maxToolRounds: 6,
      }),
    });

    const body = (await response.json()) as {
      agent?: { name: string; role: string; profile: string; maxToolRounds: number };
      error?: string;
    };

    assert.equal(response.status, 200, body.error);
    assert.equal(body.agent?.name, 'planner');
    assert.equal(body.agent?.role, 'plans the work');
    assert.equal(body.agent?.profile, 'reason');
    assert.equal(body.agent?.maxToolRounds, 6);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previousHome === undefined) {
      delete process.env['GURNEY_HOME'];
    } else {
      process.env['GURNEY_HOME'] = previousHome;
    }
    rmSync(home, { recursive: true, force: true });
  }
});
