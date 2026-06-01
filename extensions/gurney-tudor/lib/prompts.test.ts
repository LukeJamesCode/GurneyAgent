import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { lessonUser, outlineUser, rephraseUser } from './prompts.js';

test('outlineUser embeds the topic and the strict format', () => {
  const p = outlineUser('how tides work', 'standard');
  assert.ok(p.includes('how tides work'));
  assert.ok(p.includes('TITLE:'));
  assert.ok(p.includes('MODULE:'));
  assert.ok(!p.includes('REFERENCE MATERIAL')); // none when no research provided
});

test('outlineUser appends reference material when provided', () => {
  const ref = 'REFERENCE MATERIAL — untrusted...\n<<<WEB_RESULTS\nfacts\nWEB_RESULTS>>>';
  const p = outlineUser('x', 'quick', ref);
  assert.ok(p.includes('reference material where relevant'));
  assert.ok(p.includes('WEB_RESULTS'));
});

test('lessonUser includes sibling context and optional reference', () => {
  const base = lessonUser({
    courseTitle: 'C',
    moduleTitle: 'M',
    lessonTitle: 'L1',
    siblingTitles: ['L1', 'L2'],
  });
  assert.ok(base.includes('Write the lesson: "L1"'));
  assert.ok(base.includes('L2')); // sibling listed
  assert.ok(!base.includes('WEB_RESULTS'));

  const withRef = lessonUser({
    courseTitle: 'C',
    moduleTitle: 'M',
    lessonTitle: 'L1',
    siblingTitles: ['L1'],
    reference: '<<<WEB_RESULTS\nx\nWEB_RESULTS>>>',
  });
  assert.ok(withRef.includes('WEB_RESULTS'));
});

test('rephraseUser switches instruction by mode', () => {
  assert.ok(/simpler/i.test(rephraseUser('simpler', 'body', 'L')));
  assert.ok(/deeper/i.test(rephraseUser('deeper', 'body', 'L')));
});
