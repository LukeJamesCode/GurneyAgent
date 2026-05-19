import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { humanGap } from './orchestrator.js';

test('humanGap collapses sub-second to "just now"', () => {
  assert.equal(humanGap(0), 'just now');
  assert.equal(humanGap(500), 'just now');
  assert.equal(humanGap(1000), 'just now');
});

test('humanGap renders seconds, minutes, hours, days', () => {
  assert.equal(humanGap(2_000), '2s');
  assert.equal(humanGap(45_000), '45s');
  assert.equal(humanGap(60_000), '1 minute');
  assert.equal(humanGap(120_000), '2 minutes');
  assert.equal(humanGap(60 * 60_000), '1 hour');
  assert.equal(humanGap(3 * 60 * 60_000), '3 hours');
  assert.equal(humanGap(24 * 60 * 60_000), '1 day');
  assert.equal(humanGap(72 * 60 * 60_000), '3 days');
});

test('humanGap handles negative gaps as "just now" (clock skew)', () => {
  // Defensive: if a tool result lands with a slightly-future created_at the
  // model shouldn't see "-2 hours ago".
  assert.equal(humanGap(-5_000), 'just now');
});
