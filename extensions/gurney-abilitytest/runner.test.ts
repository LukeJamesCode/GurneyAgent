// Unit tests for the pure parts of gurney-abilitytest:
//   - catalog tier + filter selection
//   - judgeTest: pass/fail/info/error decisioning
//   - makeRecord: stitches a partial result into a fully-judged TurnRecord
//
// The runner's stack boot (db, ollama, extension loader) needs a real Gurney
// home and a live Ollama; that path is covered by running `gurney abilitytest`
// itself, not by node --test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { loadCatalog } from './catalog.js';
import { judgeTest } from './report.js';
import { makeRecord } from './runner.js';

const here = dirname(fileURLToPath(import.meta.url));

test('catalog: smoke tier loads only smoke tests', () => {
  const tests = loadCatalog([], here, { tier: 'smoke' });
  assert.ok(tests.length > 0, 'expected at least one smoke test');
  for (const t of tests) {
    assert.equal(t.tier, 'smoke');
  }
});

test('catalog: standard tier includes smoke + standard, never full', () => {
  const tests = loadCatalog([], here, { tier: 'standard' });
  const tiers = new Set(tests.map((t) => t.tier));
  assert.ok(tiers.has('smoke'));
  assert.ok(tiers.has('standard'));
  assert.ok(!tiers.has('full'));
});

test('catalog: full tier includes every tier', () => {
  const tests = loadCatalog([], here, { tier: 'full' });
  const tiers = new Set(tests.map((t) => t.tier));
  assert.ok(tiers.has('smoke'));
  assert.ok(tiers.has('standard'));
  assert.ok(tiers.has('full'));
});

test('catalog: --filter regex matches id or ability', () => {
  const all = loadCatalog([], here, { tier: 'full' });
  const filtered = loadCatalog([], here, { tier: 'full', filter: '^devmode' });
  assert.ok(filtered.length > 0);
  assert.ok(filtered.length < all.length);
  for (const t of filtered) {
    assert.match(t.id, /^devmode/);
  }
});

test('catalog: unknown tier throws', () => {
  assert.throws(() => loadCatalog([], here, { tier: 'made-up' as 'smoke' }));
});

test('judgeTest: info-only when no expectations are set', () => {
  const r = judgeTest({
    test: makeTest({ id: 'x', ability: 'a', tier: 'smoke', kind: 'freeform', message: 'hi' }),
    interceptReplies: [],
    reply: 'ok',
    toolsCalled: [],
    voiceEmitted: false,
    elapsedMs: 100,
  });
  assert.equal(r.status, 'info');
  assert.deepEqual(r.notes, []);
});

test('judgeTest: pass when expected tool was called', () => {
  const r = judgeTest({
    test: makeTest({
      id: 'x',
      ability: 'a',
      tier: 'smoke',
      kind: 'freeform',
      message: 'hi',
      expects: { tool: 'weather_get' },
    }),
    interceptReplies: [],
    reply: 'sunny',
    toolsCalled: [{ name: 'weather_get', ok: true }],
    voiceEmitted: false,
    elapsedMs: 100,
  });
  assert.equal(r.status, 'pass');
});

test('judgeTest: fail when expected tool was not called', () => {
  const r = judgeTest({
    test: makeTest({
      id: 'x',
      ability: 'a',
      tier: 'smoke',
      kind: 'freeform',
      message: 'hi',
      expects: { tool: 'weather_get' },
    }),
    interceptReplies: [],
    reply: 'idk',
    toolsCalled: [{ name: 'tasks_list', ok: true }],
    voiceEmitted: false,
    elapsedMs: 100,
  });
  assert.equal(r.status, 'fail');
  assert.ok(r.notes.some((n) => n.includes('weather_get')));
});

test('judgeTest: fail when expected tool was called but reported failure', () => {
  const r = judgeTest({
    test: makeTest({
      id: 'x',
      ability: 'a',
      tier: 'smoke',
      kind: 'freeform',
      message: 'hi',
      expects: { tool: 'weather_get' },
    }),
    interceptReplies: [],
    reply: 'sorry',
    toolsCalled: [{ name: 'weather_get', ok: false }],
    voiceEmitted: false,
    elapsedMs: 100,
  });
  assert.equal(r.status, 'fail');
});

test('judgeTest: error status overrides any expectation', () => {
  const r = judgeTest({
    test: makeTest({
      id: 'x',
      ability: 'a',
      tier: 'smoke',
      kind: 'freeform',
      message: 'hi',
      expects: { tool: 'weather_get' },
    }),
    interceptReplies: [],
    reply: '',
    toolsCalled: [],
    voiceEmitted: false,
    elapsedMs: 100,
    error: 'Ollama down',
  });
  assert.equal(r.status, 'error');
  assert.ok(r.notes.some((n) => n.includes('Ollama down')));
});

test('judgeTest: missing intercept reply fails the expectation', () => {
  const r = judgeTest({
    test: makeTest({
      id: 'x',
      ability: 'a',
      tier: 'smoke',
      kind: 'freeform',
      message: 'hi',
      expects: { interceptReply: true },
    }),
    interceptReplies: [],
    reply: 'something',
    toolsCalled: [],
    voiceEmitted: false,
    elapsedMs: 100,
  });
  assert.equal(r.status, 'fail');
});

test('judgeTest: missing voice payload fails when voice expected', () => {
  const r = judgeTest({
    test: makeTest({
      id: 'x',
      ability: 'a',
      tier: 'smoke',
      kind: 'freeform',
      message: 'hi',
      expects: { voice: true },
    }),
    interceptReplies: [],
    reply: 'sure',
    toolsCalled: [],
    voiceEmitted: false,
    elapsedMs: 100,
  });
  assert.equal(r.status, 'fail');
});

test('makeRecord: judged status flows through', () => {
  const rec = makeRecord(
    makeTest({
      id: 'x',
      ability: 'a',
      tier: 'smoke',
      kind: 'freeform',
      message: 'hi',
      expects: { tool: 'weather_get' },
    }),
    {
      interceptReplies: [],
      reply: 'sunny',
      toolsCalled: [{ name: 'weather_get', ok: true }],
      voiceEmitted: false,
      elapsedMs: 100,
    },
  );
  assert.equal(rec.status, 'pass');
});

function makeTest(
  o: Partial<import('./catalog.js').TestCase> &
    Pick<import('./catalog.js').TestCase, 'id' | 'ability' | 'tier' | 'kind' | 'message'>,
): import('./catalog.js').TestCase {
  return { source: 'test', ...o };
}
