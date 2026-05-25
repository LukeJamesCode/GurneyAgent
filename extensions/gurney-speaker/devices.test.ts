import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createDeviceStore } from './devices.js';

// We can't reach the extension loader's migration runner from a unit test, so
// apply the speaker migration by hand. Mirrors what loadOne does in core.
function openDbWithMigration(): { db: Database.Database; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'gurney-speaker-devices-'));
  const db = new Database(join(dir, 'g.db'));
  db.exec(`
    CREATE TABLE IF NOT EXISTS speaker_devices (
      device_id    TEXT PRIMARY KEY,
      label        TEXT,
      last_seen    INTEGER NOT NULL DEFAULT 0,
      last_volume  REAL NOT NULL DEFAULT 0.6,
      muted        INTEGER NOT NULL DEFAULT 0,
      created_at   INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
    );
  `);
  return {
    db,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('touch creates a new row with default volume + unmuted', () => {
  const { db, cleanup } = openDbWithMigration();
  try {
    const store = createDeviceStore(db);
    const row = store.touch('puck-a', 1_700_000_000_000);
    assert.equal(row.deviceId, 'puck-a');
    assert.equal(row.lastVolume, 0.6);
    assert.equal(row.muted, false);
    assert.equal(row.lastSeen, 1_700_000_000_000);
  } finally {
    cleanup();
  }
});

test('touch on an existing row bumps last_seen without overwriting volume/muted', () => {
  const { db, cleanup } = openDbWithMigration();
  try {
    const store = createDeviceStore(db);
    store.touch('puck-a', 1_700_000_000_000);
    store.saveVolumeMuted('puck-a', 0.2, true, 1_700_000_001_000);
    const after = store.touch('puck-a', 1_700_000_002_000);
    assert.equal(after.lastVolume, 0.2);
    assert.equal(after.muted, true);
    assert.equal(after.lastSeen, 1_700_000_002_000);
  } finally {
    cleanup();
  }
});

test('saveVolumeMuted clamps volume into [0,1]', () => {
  const { db, cleanup } = openDbWithMigration();
  try {
    const store = createDeviceStore(db);
    store.touch('puck-b');
    store.saveVolumeMuted('puck-b', 1.7, false);
    assert.equal(store.get('puck-b')!.lastVolume, 1);
    store.saveVolumeMuted('puck-b', -0.5, true);
    assert.equal(store.get('puck-b')!.lastVolume, 0);
    assert.equal(store.get('puck-b')!.muted, true);
  } finally {
    cleanup();
  }
});

test('get returns null for unknown devices', () => {
  const { db, cleanup } = openDbWithMigration();
  try {
    const store = createDeviceStore(db);
    assert.equal(store.get('never-seen'), null);
  } finally {
    cleanup();
  }
});

test('markSeen leaves volume/muted intact', () => {
  const { db, cleanup } = openDbWithMigration();
  try {
    const store = createDeviceStore(db);
    store.touch('puck-c', 1_700_000_000_000);
    store.saveVolumeMuted('puck-c', 0.42, true);
    store.markSeen('puck-c', 1_700_000_001_000);
    const row = store.get('puck-c')!;
    assert.equal(row.lastVolume, 0.42);
    assert.equal(row.muted, true);
    assert.equal(row.lastSeen, 1_700_000_001_000);
  } finally {
    cleanup();
  }
});
