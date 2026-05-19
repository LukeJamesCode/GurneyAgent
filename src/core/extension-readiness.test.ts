import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open as openDb } from '../storage/db.js';
import { createLogger } from '../util/log.js';
import {
  collectExtensionReadiness,
  formatSetupIssuesNudge,
  setupIssuesForNudge,
} from './extension-readiness.js';

function mkHome(): string {
  return mkdtempSync(join(tmpdir(), 'gurney-readiness-test-'));
}

function writeExtension(
  root: string,
  name: string,
  opts: {
    entrypoints?: Record<string, string>;
    schema?: {
      type: 'object';
      properties: Record<string, unknown>;
      required?: string[];
    };
  } = {},
): void {
  const folder = join(root, name);
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    join(folder, 'manifest.json'),
    JSON.stringify({
      name,
      version: '0.1.0',
      gurney: '>=0.1.0',
      ...(opts.entrypoints ? { entrypoints: opts.entrypoints } : {}),
    }),
  );
  if (opts.schema) {
    writeFileSync(join(folder, 'settings.schema.json'), JSON.stringify(opts.schema));
  }
}

test('extension readiness classifies ready, disabled, settings, and auth states', () => {
  const home = mkHome();
  try {
    const root = join(home, 'extensions');
    writeExtension(root, 'gurney-ready');
    writeExtension(root, 'gurney-disabled');
    writeExtension(root, 'gurney-settings', {
      schema: {
        type: 'object',
        properties: { required_name: { type: 'string' } },
        required: ['required_name'],
      },
    });
    writeExtension(root, 'gurney-auth', {
      entrypoints: { auth: './auth.ts' },
      schema: {
        type: 'object',
        properties: {
          google_client_id: { type: 'string' },
          google_client_secret: { type: 'string', secret: true },
          google_refresh_token: { type: 'string', secret: true },
        },
        required: ['google_client_id', 'google_client_secret'],
      },
    });

    const log = createLogger({ level: 'error', out: () => {}, err: () => {} });
    const db = openDb({ path: join(home, 'gurney.db'), log });
    try {
      db.prepare(
        `INSERT INTO extension_state (name, version, enabled, installed_at, last_loaded_at)
         VALUES ('gurney-disabled', '0.1.0', 0, ?, ?)`,
      ).run(Date.now(), Date.now());

      const readiness = collectExtensionReadiness([root], db);
      assert.equal(readiness.find((e) => e.name === 'gurney-ready')?.status, 'ready');
      assert.equal(readiness.find((e) => e.name === 'gurney-disabled')?.status, 'disabled');
      assert.equal(readiness.find((e) => e.name === 'gurney-settings')?.status, 'needs_settings');
      const auth = readiness.find((e) => e.name === 'gurney-auth');
      assert.equal(auth?.status, 'needs_auth');
      assert.equal(auth?.nextAction, 'gurney auth gurney-auth');

      const issues = setupIssuesForNudge(readiness);
      assert.deepEqual(issues.map((e) => e.name).sort(), ['gurney-auth', 'gurney-settings']);
      assert.match(formatSetupIssuesNudge(issues), /gurney-auth: needs_auth/);
    } finally {
      db.close();
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
