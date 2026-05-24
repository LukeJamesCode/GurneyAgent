import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open } from '../../src/storage/db.js';
import { getPref, setPref, prepForSpeech } from './prefs.js';

function withDb<T>(fn: (db: ReturnType<typeof open>) => T): T {
  const tmp = mkdtempSync(join(tmpdir(), 'tts-prefs-'));
  const db = open({ path: join(tmp, 'g.db') });
  // Mirror the per-extension migration; the smoke test exercises the real
  // migration path via the loader.
  db.exec(
    `CREATE TABLE tts_chat_prefs (chat_id INTEGER PRIMARY KEY, enabled INTEGER NOT NULL, updated_at INTEGER NOT NULL);`,
  );
  try {
    return fn(db);
  } finally {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  }
}

test('getPref returns the configured fallback when no row exists', () => {
  withDb((db) => {
    assert.equal(getPref(db, 1, false), false);
    assert.equal(getPref(db, 1, true), true);
  });
});

test('setPref upserts and getPref reads it back', () => {
  withDb((db) => {
    setPref(db, 42, true);
    assert.equal(getPref(db, 42, false), true);
    setPref(db, 42, false);
    assert.equal(getPref(db, 42, true), false);
  });
});

test('prepForSpeech strips fenced code blocks', () => {
  const out = prepForSpeech('Hello.\n\n```\nlet x = 1\n```\n\nDone.', 600);
  assert.match(out!, /Hello\./);
  assert.match(out!, /code omitted/);
  assert.match(out!, /Done\./);
});

test('prepForSpeech strips inline code and Markdown emphasis', () => {
  const out = prepForSpeech('Run `npm test` to see *all* the **tests** ~now~.', 600);
  assert.equal(out, 'Run npm test to see all the tests now.');
});

test('prepForSpeech returns null for empty or oversized input', () => {
  assert.equal(prepForSpeech('   ', 600), null);
  assert.equal(prepForSpeech('a'.repeat(700), 600), null);
});
