import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { parseLesson, parseOutline, stripThink } from './parse.js';

test('stripThink removes qwen reasoning blocks', () => {
  assert.equal(stripThink('<think>hmm let me plan</think>\nHello'), 'Hello');
  assert.equal(stripThink('/no_think\nHi'), 'Hi');
});

test('parseOutline reads the tagged format', () => {
  const out = parseOutline(
    [
      'TITLE: Understanding Tides',
      'MODULE: The Moon and Gravity',
      'SUMMARY: why the moon pulls the sea',
      '- Gravity in one minute',
      '- The pull of the moon',
      'MODULE: Two Bulges',
      '- Why there are two high tides',
    ].join('\n'),
  );
  assert.equal(out.title, 'Understanding Tides');
  assert.equal(out.modules.length, 2);
  assert.equal(out.modules[0]!.summary, 'why the moon pulls the sea');
  assert.deepEqual(out.modules[0]!.lessons, ['Gravity in one minute', 'The pull of the moon']);
  assert.equal(out.modules[1]!.lessons.length, 1);
});

test('parseOutline falls back to a single module for a bare bullet list', () => {
  const out = parseOutline('- First thing\n- Second thing');
  assert.equal(out.modules.length, 1);
  assert.equal(out.modules[0]!.lessons.length, 2);
});

test('parseOutline throws when nothing is parseable', () => {
  assert.throws(() => parseOutline('I cannot help with that.'));
});

test('parseOutline dedupes and caps lessons', () => {
  const out = parseOutline(
    ['MODULE: M', '- a', '- a', '- b', '- c', '- d', '- e', '- f', '- g'].join('\n'),
  );
  assert.equal(out.modules[0]!.lessons.length, 6); // MAX_LESSONS_PER_MODULE, after dedupe
});

test('parseLesson reads segments and a quiz', () => {
  const lesson = parseLesson(
    [
      'SEGMENT: explain',
      'Tides are the rise and fall of sea levels.',
      'SEGMENT: analogy',
      'Think of the ocean as water in a spinning bucket.',
      'QUIZ:',
      'Q: What causes tides?',
      '- The wind',
      '- The moon’s gravity',
      '- Ocean currents',
      'CORRECT: B',
      'WHY: The moon’s gravity pulls the ocean.',
    ].join('\n'),
  );
  assert.equal(lesson.segments.length, 2);
  assert.equal(lesson.segments[0]!.kind, 'explain');
  assert.equal(lesson.segments[1]!.kind, 'analogy');
  assert.equal(lesson.quiz.length, 1);
  assert.equal(lesson.quiz[0]!.choices.length, 3);
  assert.equal(lesson.quiz[0]!.answerIdx, 1); // "B" -> index 1
});

test('parseLesson normalises unknown kinds and resolves numeric answers', () => {
  const lesson = parseLesson(
    ['SEGMENT: intro', 'Hi.', 'QUIZ:', 'Q: x?', '- one', '- two', 'CORRECT: 2'].join('\n'),
  );
  assert.equal(lesson.segments[0]!.kind, 'explain'); // 'intro' -> 'explain'
  assert.equal(lesson.quiz[0]!.answerIdx, 1); // "2" -> index 1
});

test('parseLesson falls back to one segment when there are no markers', () => {
  const lesson = parseLesson('Just a paragraph with no markers at all.');
  assert.equal(lesson.segments.length, 1);
  assert.equal(lesson.segments[0]!.kind, 'explain');
  assert.equal(lesson.quiz.length, 0);
});

test('parseLesson drops a quiz with too few choices', () => {
  const lesson = parseLesson(
    ['SEGMENT: explain', 'Body.', 'QUIZ:', 'Q: x?', '- only one'].join('\n'),
  );
  assert.equal(lesson.quiz.length, 0);
});
