import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as ext from './ext.js';
import { open as openDb } from '../storage/db.js';
import { createLogger } from '../util/log.js';

function mkHome(): string {
  return mkdtempSync(join(tmpdir(), 'gurney-ext-cli-test-'));
}

function writeManifest(folder: string, name: string, version = '0.1.0'): void {
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    join(folder, 'manifest.json'),
    JSON.stringify({ name, version, gurney: '>=0.1.0' }),
  );
}

function captureStdout(fn: () => Promise<void>): Promise<string> {
  const buf: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: (s: unknown) => boolean }).write = (s: unknown) => {
    buf.push(typeof s === 'string' ? s : String(s));
    return true;
  };
  return fn()
    .then(() => buf.join(''))
    .finally(() => {
      process.stdout.write = orig;
    });
}

test('ext.install copies a local folder into ~/.gurney/extensions/', async () => {
  const home = mkHome();
  const oldHome = process.env['GURNEY_HOME'];
  process.env['GURNEY_HOME'] = home;
  try {
    const src = join(home, 'src-ext');
    writeManifest(src, 'gurney-fake');
    writeFileSync(join(src, 'tools.ts'), '// fake');

    const out = await captureStdout(() => ext.install(src));
    assert.match(out, /Installed 'gurney-fake'/);
    const dest = join(home, 'extensions', 'gurney-fake');
    assert.ok(existsSync(join(dest, 'manifest.json')));
    assert.ok(existsSync(join(dest, 'tools.ts')));
  } finally {
    if (oldHome === undefined) delete process.env['GURNEY_HOME'];
    else process.env['GURNEY_HOME'] = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test('ext.list shows installed extensions and their state', async () => {
  const home = mkHome();
  const oldHome = process.env['GURNEY_HOME'];
  process.env['GURNEY_HOME'] = home;
  try {
    writeManifest(join(home, 'extensions', 'gurney-a'), 'gurney-a', '1.0.0');
    writeManifest(join(home, 'extensions', 'gurney-b'), 'gurney-b', '2.0.0');

    // Open DB to apply migrations so extension_state exists.
    const log = createLogger({ level: 'error', out: () => {}, err: () => {} });
    const db = openDb({ path: join(home, 'gurney.db'), log });
    db.prepare(
      `INSERT INTO extension_state (name, version, enabled, installed_at, last_loaded_at)
       VALUES ('gurney-a', '1.0.0', 0, ?, ?)`,
    ).run(Date.now(), Date.now());
    db.close();

    const out = await captureStdout(() => ext.list());
    assert.match(out, /gurney-a@1\.0\.0\s+\[disabled\]/);
    assert.match(out, /next: gurney ext enable gurney-a/);
    assert.match(out, /gurney-b@2\.0\.0\s+\[ready\]/);
  } finally {
    if (oldHome === undefined) delete process.env['GURNEY_HOME'];
    else process.env['GURNEY_HOME'] = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test('ext.enable / ext.disable flip extension_state.enabled', async () => {
  const home = mkHome();
  const oldHome = process.env['GURNEY_HOME'];
  process.env['GURNEY_HOME'] = home;
  try {
    writeManifest(join(home, 'extensions', 'gurney-x'), 'gurney-x', '0.1.0');

    await captureStdout(() => ext.disable('gurney-x'));
    let log = createLogger({ level: 'error', out: () => {}, err: () => {} });
    let db = openDb({ path: join(home, 'gurney.db'), log });
    let row = db.prepare(`SELECT enabled FROM extension_state WHERE name = ?`).get('gurney-x') as
      | { enabled: number }
      | undefined;
    assert.equal(row?.enabled, 0);
    db.close();

    await captureStdout(() => ext.enable('gurney-x'));
    log = createLogger({ level: 'error', out: () => {}, err: () => {} });
    db = openDb({ path: join(home, 'gurney.db'), log });
    row = db.prepare(`SELECT enabled FROM extension_state WHERE name = ?`).get('gurney-x') as
      | { enabled: number }
      | undefined;
    assert.equal(row?.enabled, 1);
    db.close();
  } finally {
    if (oldHome === undefined) delete process.env['GURNEY_HOME'];
    else process.env['GURNEY_HOME'] = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test('ext.uninstall --purge drops settings and state rows', async () => {
  const home = mkHome();
  const oldHome = process.env['GURNEY_HOME'];
  process.env['GURNEY_HOME'] = home;
  try {
    const folder = join(home, 'extensions', 'gurney-y');
    writeManifest(folder, 'gurney-y', '0.1.0');

    const log = createLogger({ level: 'error', out: () => {}, err: () => {} });
    const db = openDb({ path: join(home, 'gurney.db'), log });
    db.prepare(
      `INSERT INTO extension_state (name, version, enabled, installed_at, last_loaded_at)
       VALUES ('gurney-y', '0.1.0', 1, ?, ?)`,
    ).run(Date.now(), Date.now());
    db.prepare(
      `INSERT INTO extension_settings (extension, key, value, updated_at) VALUES ('gurney-y', 'k', 'v', ?)`,
    ).run(Date.now());
    db.close();

    await captureStdout(() => ext.uninstall('gurney-y', { purge: true }));
    assert.equal(existsSync(folder), false);

    const log2 = createLogger({ level: 'error', out: () => {}, err: () => {} });
    const db2 = openDb({ path: join(home, 'gurney.db'), log: log2 });
    const stateRow = db2.prepare(`SELECT * FROM extension_state WHERE name = ?`).get('gurney-y');
    const settingsRow = db2
      .prepare(`SELECT * FROM extension_settings WHERE extension = ?`)
      .get('gurney-y');
    assert.equal(stateRow, undefined);
    assert.equal(settingsRow, undefined);
    db2.close();
  } finally {
    if (oldHome === undefined) delete process.env['GURNEY_HOME'];
    else process.env['GURNEY_HOME'] = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test('ext.reload touches manifests so the file watcher fires', async () => {
  const home = mkHome();
  const oldHome = process.env['GURNEY_HOME'];
  process.env['GURNEY_HOME'] = home;
  try {
    const folder = join(home, 'extensions', 'gurney-z');
    writeManifest(folder, 'gurney-z', '0.1.0');
    const before = readFileSync(join(folder, 'manifest.json'), 'utf8');
    await captureStdout(() => ext.reload('gurney-z'));
    const after = readFileSync(join(folder, 'manifest.json'), 'utf8');
    assert.equal(before, after); // content unchanged, only mtime nudged
  } finally {
    if (oldHome === undefined) delete process.env['GURNEY_HOME'];
    else process.env['GURNEY_HOME'] = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test('ext.create scaffolds a runnable starter extension', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'gurney-ext-create-'));
  try {
    await captureStdout(() => ext.create('gurney-demo', parent));
    const dest = join(parent, 'gurney-demo');
    const manifest = JSON.parse(readFileSync(join(dest, 'manifest.json'), 'utf8')) as {
      name: string;
      version: string;
      gurney: string;
      entrypoints?: Record<string, string>;
      telegram_commands?: Array<{ command: string }>;
    };
    assert.equal(manifest.name, 'gurney-demo');
    assert.equal(manifest.version, '0.1.0');
    assert.equal(manifest.gurney, '>=0.1.0');
    assert.equal(manifest.entrypoints?.['tools'], './tools.ts');
    assert.equal(manifest.entrypoints?.['commands'], './commands.ts');
    assert.equal(manifest.telegram_commands?.[0]?.command, 'demo');
    assert.ok(existsSync(join(dest, 'tools.ts')));
    assert.ok(existsSync(join(dest, 'commands.ts')));
    assert.ok(existsSync(join(dest, 'settings.schema.json')));
    assert.ok(existsSync(join(dest, 'README.md')));
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
