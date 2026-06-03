import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import type { DB } from '../../../src/storage/db.js';
import type { ParsedLesson, ParsedOutline } from './types.js';
import * as store from './store.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, '..', 'migrations');

function freshDb(): DB {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  // Apply every migration in order so the test schema matches production.
  for (const f of readdirSync(MIGRATIONS_DIR)
    .filter((n) => n.endsWith('.sql'))
    .sort()) {
    db.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'));
  }
  return db as unknown as DB;
}

test('legacy 0003 image migration stays immutable before visualization migration', () => {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((n) => n.endsWith('.sql'))
    .sort();
  assert.deepEqual(files.slice(0, 4), [
    '0001_tudor.sql',
    '0002_tudor_sources.sql',
    '0003_tudor_segment_images.sql',
    '0004_tudor_visualization.sql',
  ]);

  const sql = readFileSync(join(MIGRATIONS_DIR, '0003_tudor_segment_images.sql'), 'utf8');
  assert.equal(
    createHash('sha256').update(sql).digest('hex'),
    '30b5d240d6e08f23cd9f52445b709cd95bc543a5d05b1477f5b6bc6f02f36747',
  );
});

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

test('saveSources persists sources, exposes them on the tree, and cascades on delete', () => {
  const db = freshDb();
  const id = store.createCourse(db, { topic: 'tides', depth: 'quick', model: 'm' });
  store.persistOutline(db, id, OUTLINE);
  store.saveSources(db, id, [
    { title: 'NOAA Tides', url: 'https://noaa.gov/tides', domain: 'noaa.gov' },
    { title: 'Moon & Sea', url: 'https://example.com/moon' },
  ]);
  // Idempotent: re-saving replaces rather than duplicates.
  store.saveSources(db, id, [
    { title: 'NOAA Tides', url: 'https://noaa.gov/tides', domain: 'noaa.gov' },
  ]);

  const list = store.listSources(db, id);
  assert.equal(list.length, 1);
  assert.equal(list[0]!.domain, 'noaa.gov');

  const tree = store.getCourseTree(db, id)!;
  assert.equal(tree.sources.length, 1);
  assert.equal(tree.sources[0]!.url, 'https://noaa.gov/tides');

  store.deleteCourse(db, id);
  const n = db.prepare(`SELECT COUNT(*) AS n FROM tudor_sources`).get() as { n: number };
  assert.equal(n.n, 0);
});

test('lessonContext resolves course/module/sibling info from a lesson id', () => {
  const db = freshDb();
  const id = store.createCourse(db, { topic: 'tides', depth: 'standard', model: 'm' });
  const lessons = store.persistOutline(db, id, OUTLINE);
  const ctx = store.lessonContext(db, lessons[0]!.id);
  assert.ok(ctx);
  assert.equal(ctx!.courseId, id);
  assert.equal(ctx!.courseTitle, 'Understanding Tides');
  assert.equal(ctx!.moduleTitle, 'Gravity');
  assert.equal(ctx!.lessonTitle, 'Pull of the moon');
  assert.deepEqual(ctx!.siblingTitles, ['Pull of the moon', 'Two bulges']);
  assert.equal(store.lessonContext(db, 'nope'), null);
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
