// Test that 0001_adopt_existing_tables.sql:
// 1. Creates reminders and calendar_nudges_sent tables if not present.
// 2. Migrates settings from the 5 old extensions into gurney-everyday-assistant.
// 3. Removes old extension rows so the namespace is clean.
// 4. Preserves pre-existing data in the tables (rows survive the migration).

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { open } from '../../../src/storage/db.js';

const here = dirname(fileURLToPath(import.meta.url));
const sql0001 = readFileSync(join(here, '0001_adopt_existing_tables.sql'), 'utf8');

function runMigration(db: ReturnType<typeof open>): void {
  // SQLite's exec can't run multiple statements if using better-sqlite3 prepare.
  // Split on ';' and run each non-empty statement individually.
  for (const stmt of sql0001.split(';')) {
    const s = stmt.trim();
    if (s) db.prepare(s).run();
  }
}

function seedSetting(
  db: ReturnType<typeof open>,
  extension: string,
  key: string,
  value: string,
): void {
  db.prepare(
    `INSERT INTO extension_settings (extension, key, value, updated_at) VALUES (?, ?, ?, ?)`,
  ).run(extension, key, value, Date.now());
}

function getSetting(
  db: ReturnType<typeof open>,
  extension: string,
  key: string,
): string | undefined {
  const row = db
    .prepare(`SELECT value FROM extension_settings WHERE extension=? AND key=?`)
    .get(extension, key) as { value: string } | undefined;
  return row?.value;
}

test('migration creates reminders and calendar_nudges_sent tables', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ged-mig0001-'));
  try {
    const db = open({ path: join(tmp, 'g.db') });
    runMigration(db);

    for (const table of ['reminders', 'calendar_nudges_sent']) {
      const row = db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
        .get(table) as { name: string } | undefined;
      assert.ok(row, `table "${table}" should exist after migration`);
    }
    db.close();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('migration is idempotent: safe to run twice', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ged-mig0001-idem-'));
  try {
    const db = open({ path: join(tmp, 'g.db') });
    runMigration(db);
    assert.doesNotThrow(() => runMigration(db), 'second run should not throw');
    db.close();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('migration copies calendar settings with key renames', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ged-mig0001-cal-'));
  try {
    const db = open({ path: join(tmp, 'g.db') });
    seedSetting(db, 'gurney-google-calendar', 'client_id', 'CAL-CID');
    seedSetting(db, 'gurney-google-calendar', 'client_secret', 'CAL-CSEC');
    seedSetting(db, 'gurney-google-calendar', 'refresh_token', 'CAL-RTOK');
    seedSetting(db, 'gurney-google-calendar', 'calendar_id', 'primary');
    seedSetting(db, 'gurney-google-calendar', 'nudge_lookahead_minutes', '20');
    seedSetting(db, 'gurney-google-calendar', 'nudge_chat_id', '9999');
    runMigration(db);

    assert.equal(getSetting(db, 'gurney-everyday-assistant', 'google_client_id'), 'CAL-CID');
    assert.equal(getSetting(db, 'gurney-everyday-assistant', 'google_client_secret'), 'CAL-CSEC');
    assert.equal(getSetting(db, 'gurney-everyday-assistant', 'google_refresh_token'), 'CAL-RTOK');
    assert.equal(getSetting(db, 'gurney-everyday-assistant', 'calendar_id'), 'primary');
    assert.equal(getSetting(db, 'gurney-everyday-assistant', 'nudge_lookahead_minutes'), '20');
    assert.equal(getSetting(db, 'gurney-everyday-assistant', 'nudge_chat_id'), '9999');
    db.close();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('migration does NOT copy tasks refresh_token (wrong scope)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ged-mig0001-taskstok-'));
  try {
    const db = open({ path: join(tmp, 'g.db') });
    seedSetting(db, 'gurney-google-tasks', 'client_id', 'TSK-CID');
    seedSetting(db, 'gurney-google-tasks', 'client_secret', 'TSK-CSEC');
    seedSetting(db, 'gurney-google-tasks', 'refresh_token', 'TSK-RTOK-WRONG-SCOPE');
    seedSetting(db, 'gurney-google-tasks', 'default_tasklist', '@work');
    runMigration(db);

    // tasks's refresh_token must NOT be copied
    assert.equal(getSetting(db, 'gurney-everyday-assistant', 'google_refresh_token'), undefined);
    // other tasks settings should copy
    assert.equal(getSetting(db, 'gurney-everyday-assistant', 'default_tasklist'), '@work');
    db.close();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('calendar client_id wins over tasks client_id (INSERT OR IGNORE precedence)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ged-mig0001-prec-'));
  try {
    const db = open({ path: join(tmp, 'g.db') });
    // Calendar is inserted first → wins for google_client_id
    seedSetting(db, 'gurney-google-calendar', 'client_id', 'CAL-CID');
    seedSetting(db, 'gurney-google-tasks', 'client_id', 'TSK-CID');
    runMigration(db);

    // calendar's value should be kept (INSERT OR IGNORE)
    assert.equal(getSetting(db, 'gurney-everyday-assistant', 'google_client_id'), 'CAL-CID');
    db.close();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('migration copies weather and briefing settings', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ged-mig0001-briefing-'));
  try {
    const db = open({ path: join(tmp, 'g.db') });
    seedSetting(db, 'gurney-weather', 'default_location', 'London');
    seedSetting(db, 'gurney-briefing', 'morning_cron', '0 8 * * *');
    seedSetting(db, 'gurney-briefing', 'night_cron', '0 22 * * *');
    seedSetting(db, 'gurney-briefing', 'time_zone', 'Europe/London');
    seedSetting(db, 'gurney-briefing', 'chat_id', '1234');
    seedSetting(db, 'gurney-briefing', 'weather_location', 'Paris');
    runMigration(db);

    assert.equal(getSetting(db, 'gurney-everyday-assistant', 'default_location'), 'London');
    assert.equal(getSetting(db, 'gurney-everyday-assistant', 'morning_cron'), '0 8 * * *');
    assert.equal(getSetting(db, 'gurney-everyday-assistant', 'night_cron'), '0 22 * * *');
    assert.equal(getSetting(db, 'gurney-everyday-assistant', 'time_zone'), 'Europe/London');
    assert.equal(getSetting(db, 'gurney-everyday-assistant', 'briefing_chat_id'), '1234');
    // weather_location → default_location: London already set, INSERT OR IGNORE keeps it
    assert.equal(getSetting(db, 'gurney-everyday-assistant', 'default_location'), 'London');
    db.close();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('migration removes all old extension rows', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ged-mig0001-clean-'));
  try {
    const db = open({ path: join(tmp, 'g.db') });
    for (const ext of [
      'gurney-google-calendar',
      'gurney-google-tasks',
      'gurney-reminders',
      'gurney-weather',
      'gurney-briefing',
    ]) {
      seedSetting(db, ext, 'some_key', 'some_value');
    }
    runMigration(db);

    for (const ext of [
      'gurney-google-calendar',
      'gurney-google-tasks',
      'gurney-reminders',
      'gurney-weather',
      'gurney-briefing',
    ]) {
      const count = db
        .prepare(`SELECT COUNT(*) as n FROM extension_settings WHERE extension=?`)
        .get(ext) as { n: number };
      assert.equal(count.n, 0, `old extension "${ext}" should have no rows after migration`);
    }
    db.close();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('pre-existing reminders rows survive the migration', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ged-mig0001-reminders-'));
  try {
    const db = open({ path: join(tmp, 'g.db') });
    // Create reminders table first (simulating an existing install)
    db.prepare(
      `CREATE TABLE reminders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id INTEGER NOT NULL,
        text TEXT NOT NULL,
        fire_at INTEGER NOT NULL,
        fired INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      )`,
    ).run();
    db.prepare(
      `INSERT INTO reminders (chat_id, text, fire_at, fired, created_at) VALUES (1, 'Call dentist', 9999999, 0, 1)`,
    ).run();

    runMigration(db);

    // Row must still be there
    const row = db.prepare(`SELECT text FROM reminders WHERE text='Call dentist'`).get() as
      | { text: string }
      | undefined;
    assert.ok(row, 'pre-existing reminder should survive migration');
    db.close();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('pre-existing calendar_nudges_sent rows survive the migration', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ged-mig0001-nudges-'));
  try {
    const db = open({ path: join(tmp, 'g.db') });
    db.prepare(
      `CREATE TABLE calendar_nudges_sent (
        event_id TEXT NOT NULL,
        fire_minute INTEGER NOT NULL,
        chat_id INTEGER NOT NULL,
        sent_at INTEGER NOT NULL,
        PRIMARY KEY (event_id, fire_minute, chat_id)
      )`,
    ).run();
    db.prepare(
      `INSERT INTO calendar_nudges_sent (event_id, fire_minute, chat_id, sent_at)
       VALUES ('evt-abc', 123456, 1, 111111)`,
    ).run();

    runMigration(db);

    const row = db
      .prepare(`SELECT event_id FROM calendar_nudges_sent WHERE event_id='evt-abc'`)
      .get() as { event_id: string } | undefined;
    assert.ok(row, 'pre-existing nudge-sent record should survive migration');
    db.close();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
