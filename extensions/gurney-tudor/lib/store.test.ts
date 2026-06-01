import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import type { DB } from '../../../src/storage/db.js';
import type { ParsedLesson, ParsedOutline } from './types.js';
import * as store from './store.js';

const HERE = dirname(fileURLToPath(import.meta.url));

function freshDb(): DB {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(readFileSync(join(HERE, '..', 'migrations', '0001_tudor.sql'), 'utf8'));
  return db as unknown as DB;
}

const OUTLINE: ParsedOutline = {
  title: 'Understanding Tides',
  modules: [
    { title: 'Gravity', summary: 'the basics', lessons: ['Pull of the moon', 'Two bulges'] },
    { title: 'Cycles', summary: '', lessons: ['Spring and neap'] },
  ],
};

const LESSON: ParsedLesson = {
  segments: [
    { kind: 'explain', body: 'Tides rise and fall.' },
    { kind: 'analogy', body: 'Like water in a bucket.' },
  ],
  quiz: [
    {
      question: 'What causes tides?',
      choices: ['Wind', 'The moon'],
      answerIdx: 1,
      why: 'Gravity.',
    },
  ],
};

test('createCourse + persistOutline build a readable tree', () => {
  const db = freshDb();
  const id = store.createCourse(db, { topic: 'tides', depth: 'standard', model: 'qwen3.5:2b' });
  const lessons = store.persistOutline(db, id, OUTLINE);
  assert.equal(lessons.length, 3);

  const tree = store.getCourseTree(db, id);
  assert.ok(tree);
  assert.equal(tree!.course.title, 'Understanding Tides');
  assert.equal(tree!.modules.length, 2);
  assert.equal(tree!.modules[0]!.lessons.length, 2);
  assert.equal(tree!.modules[0]!.lessons[0]!.status, 'pending');
});

test('replaceLessonContent is idempotent and marks the lesson ready', () => {
  const db = freshDb();
  const id = store.createCourse(db, { topic: 'tides', depth: 'quick', model: 'm' });
  const lessons = store.persistOutline(db, id, OUTLINE);
  const first = lessons[0]!;

  store.replaceLessonContent(db, first.id, LESSON, 5);
  store.replaceLessonContent(db, first.id, LESSON, 5); // re-run must not duplicate

  const tree = store.getCourseTree(db, id)!;
  const lesson = tree.modules[0]!.lessons[0]!;
  assert.equal(lesson.status, 'ready');
  assert.equal(lesson.segments.length, 2);
  assert.equal(lesson.quizzes.length, 1);
  assert.equal(JSON.parse(lesson.quizzes[0]!.choices_json).length, 2);
  assert.equal(lesson.quizzes[0]!.answer_idx, 1);
});

test('progress is clamped and reflected in the tree and summary', () => {
  const db = freshDb();
  const id = store.createCourse(db, { topic: 'tides', depth: 'quick', model: 'm' });
  const lessons = store.persistOutline(db, id, OUTLINE);
  store.upsertProgress(db, id, lessons[0]!.id, 'done', 9); // confidence over-range
  store.upsertProgress(db, id, lessons[0]!.id, 'done', 2); // update wins

  const tree = store.getCourseTree(db, id)!;
  assert.equal(tree.modules[0]!.lessons[0]!.progress, 'done');
  assert.equal(tree.modules[0]!.lessons[0]!.confidence, 2);

  const summary = store.listCourses(db).find((c) => c.id === id)!;
  assert.equal(summary.doneCount, 1);
  assert.equal(summary.lessonCount, 3);
});

test('deleteCourse cascades to children', () => {
  const db = freshDb();
  const id = store.createCourse(db, { topic: 'tides', depth: 'quick', model: 'm' });
  store.persistOutline(db, id, OUTLINE);
  store.deleteCourse(db, id);
  assert.equal(store.getCourse(db, id), null);
  const segs = db.prepare(`SELECT COUNT(*) AS n FROM tudor_segments`).get() as { n: number };
  const mods = db.prepare(`SELECT COUNT(*) AS n FROM tudor_modules`).get() as { n: number };
  assert.equal(mods.n, 0);
  assert.equal(segs.n, 0);
});

test('pending-lesson listing respects order and status', () => {
  const db = freshDb();
  const id = store.createCourse(db, { topic: 'tides', depth: 'quick', model: 'm' });
  const lessons = store.persistOutline(db, id, OUTLINE);
  store.replaceLessonContent(db, lessons[0]!.id, LESSON, 5); // now ready
  const pending = store.listPendingLessons(db, id);
  assert.equal(pending.length, 2);
  assert.equal(pending[0]!.title, 'Two bulges');
});
