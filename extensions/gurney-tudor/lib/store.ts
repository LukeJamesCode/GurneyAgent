// SQLite data-access for gurney-tudor. Pure functions over a `DB` handle so the
// same code serves the extension's Telegram command and the frontend's HTTP
// routes, and so it's testable against an in-memory database.

import { randomUUID } from 'node:crypto';
import type { DB } from '../../../src/storage/db.js';
import type {
  CourseRow,
  CourseStatus,
  Depth,
  JobRow,
  LessonRow,
  LessonStatus,
  ModuleRow,
  ParsedLesson,
  ParsedOutline,
  ProgressRow,
  ProgressState,
  QuizRow,
  SegmentRow,
} from './types.js';

export function createCourse(db: DB, args: { topic: string; depth: Depth; model: string }): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO tudor_courses (id, topic, title, status, model, depth, created_at)
     VALUES (?, ?, NULL, 'generating', ?, ?, ?)`,
  ).run(id, args.topic, args.model, args.depth, Date.now());
  db.prepare(
    `INSERT INTO tudor_jobs (course_id, phase, done, total, updated_at) VALUES (?, 'outline', 0, 0, ?)`,
  ).run(id, Date.now());
  return id;
}

export function getCourse(db: DB, id: string): CourseRow | null {
  return (db.prepare(`SELECT * FROM tudor_courses WHERE id = ?`).get(id) as CourseRow) ?? null;
}

export function setCourseTitle(db: DB, id: string, title: string): void {
  db.prepare(`UPDATE tudor_courses SET title = ? WHERE id = ?`).run(title, id);
}

export function setCourseModel(db: DB, id: string, model: string): void {
  db.prepare(`UPDATE tudor_courses SET model = ? WHERE id = ?`).run(model, id);
}

export function setCourseStatus(db: DB, id: string, status: CourseStatus): void {
  const readyAt = status === 'ready' ? Date.now() : null;
  db.prepare(`UPDATE tudor_courses SET status = ?, ready_at = ? WHERE id = ?`).run(
    status,
    readyAt,
    id,
  );
}

// Persist the parsed outline as modules + pending lessons. Returns the lesson
// ids in generation order. Wrapped in a transaction so a course tree never
// appears half-built to a concurrent reader.
export function persistOutline(db: DB, courseId: string, outline: ParsedOutline): LessonRow[] {
  const insertModule = db.prepare(
    `INSERT INTO tudor_modules (id, course_id, idx, title, summary) VALUES (?, ?, ?, ?, ?)`,
  );
  const insertLesson = db.prepare(
    `INSERT INTO tudor_lessons (id, module_id, idx, title, status, est_minutes)
     VALUES (?, ?, ?, ?, 'pending', NULL)`,
  );
  const lessons: LessonRow[] = [];
  db.transaction(() => {
    setCourseTitle(db, courseId, outline.title);
    outline.modules.forEach((m, mi) => {
      const moduleId = randomUUID();
      insertModule.run(moduleId, courseId, mi, m.title, m.summary || null);
      m.lessons.forEach((title, li) => {
        const lessonId = randomUUID();
        insertLesson.run(lessonId, moduleId, li, title);
        lessons.push({
          id: lessonId,
          module_id: moduleId,
          idx: li,
          title,
          status: 'pending',
          est_minutes: null,
        });
      });
    });
  })();
  return lessons;
}

export function setLessonStatus(db: DB, lessonId: string, status: LessonStatus): void {
  db.prepare(`UPDATE tudor_lessons SET status = ? WHERE id = ?`).run(status, lessonId);
}

export function listPendingLessons(db: DB, courseId: string): LessonRow[] {
  return db
    .prepare(
      `SELECT l.* FROM tudor_lessons l
       JOIN tudor_modules m ON m.id = l.module_id
       WHERE m.course_id = ? AND l.status IN ('pending', 'generating')
       ORDER BY m.idx, l.idx`,
    )
    .all(courseId) as LessonRow[];
}

export function moduleSiblingTitles(db: DB, moduleId: string): string[] {
  const rows = db
    .prepare(`SELECT title FROM tudor_lessons WHERE module_id = ? ORDER BY idx`)
    .all(moduleId) as Array<{ title: string }>;
  return rows.map((r) => r.title);
}

export function moduleTitle(db: DB, moduleId: string): string {
  const row = db.prepare(`SELECT title FROM tudor_modules WHERE id = ?`).get(moduleId) as
    | { title: string }
    | undefined;
  return row?.title ?? '';
}

// Replace a lesson's generated content. Idempotent: re-running a lesson (resume
// or regenerate) clears the prior segments/quizzes first.
export function replaceLessonContent(
  db: DB,
  lessonId: string,
  lesson: ParsedLesson,
  estMinutes: number,
): void {
  const insertSeg = db.prepare(
    `INSERT INTO tudor_segments (id, lesson_id, idx, kind, body_md, narration, variants_json)
     VALUES (?, ?, ?, ?, ?, NULL, NULL)`,
  );
  const insertQuiz = db.prepare(
    `INSERT INTO tudor_quizzes (id, lesson_id, idx, question, choices_json, answer_idx, explain_md)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  db.transaction(() => {
    db.prepare(`DELETE FROM tudor_segments WHERE lesson_id = ?`).run(lessonId);
    db.prepare(`DELETE FROM tudor_quizzes WHERE lesson_id = ?`).run(lessonId);
    lesson.segments.forEach((s, i) => {
      insertSeg.run(randomUUID(), lessonId, i, s.kind, s.body);
    });
    lesson.quiz.forEach((q, i) => {
      insertQuiz.run(
        randomUUID(),
        lessonId,
        i,
        q.question,
        JSON.stringify(q.choices),
        q.answerIdx,
        q.why || null,
      );
    });
    db.prepare(`UPDATE tudor_lessons SET status = 'ready', est_minutes = ? WHERE id = ?`).run(
      estMinutes,
      lessonId,
    );
  })();
}

// --- Jobs ---

export function getJob(db: DB, courseId: string): JobRow | null {
  return (
    (db.prepare(`SELECT * FROM tudor_jobs WHERE course_id = ?`).get(courseId) as JobRow) ?? null
  );
}

export function updateJob(
  db: DB,
  courseId: string,
  patch: { phase?: 'outline' | 'lessons'; done?: number; total?: number; error?: string | null },
): void {
  const job = getJob(db, courseId);
  const phase = patch.phase ?? job?.phase ?? 'outline';
  const done = patch.done ?? job?.done ?? 0;
  const total = patch.total ?? job?.total ?? 0;
  const error = patch.error === undefined ? (job?.error ?? null) : patch.error;
  db.prepare(
    `INSERT INTO tudor_jobs (course_id, phase, done, total, error, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(course_id) DO UPDATE SET
       phase = excluded.phase, done = excluded.done, total = excluded.total,
       error = excluded.error, updated_at = excluded.updated_at`,
  ).run(courseId, phase, done, total, error, Date.now());
}

// --- Reads for the UI ---

export interface CourseSummary {
  id: string;
  topic: string;
  title: string | null;
  status: CourseStatus;
  model: string | null;
  depth: Depth;
  created_at: number;
  lessonCount: number;
  readyCount: number;
  doneCount: number;
}

export function listCourses(db: DB): CourseSummary[] {
  const courses = db
    .prepare(`SELECT * FROM tudor_courses ORDER BY created_at DESC`)
    .all() as CourseRow[];
  return courses.map((c) => {
    const counts = db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN l.status = 'ready' THEN 1 ELSE 0 END) AS ready
         FROM tudor_lessons l JOIN tudor_modules m ON m.id = l.module_id
         WHERE m.course_id = ?`,
      )
      .get(c.id) as { total: number; ready: number | null };
    const done = db
      .prepare(`SELECT COUNT(*) AS n FROM tudor_progress WHERE course_id = ? AND state = 'done'`)
      .get(c.id) as { n: number };
    return {
      id: c.id,
      topic: c.topic,
      title: c.title,
      status: c.status,
      model: c.model,
      depth: c.depth,
      created_at: c.created_at,
      lessonCount: counts.total,
      readyCount: counts.ready ?? 0,
      doneCount: done.n,
    };
  });
}

export interface CourseTree {
  course: CourseRow;
  job: JobRow | null;
  modules: Array<
    ModuleRow & {
      lessons: Array<
        LessonRow & {
          segments: SegmentRow[];
          quizzes: QuizRow[];
          progress: ProgressState;
          confidence: number;
        }
      >;
    }
  >;
}

export function getCourseTree(db: DB, id: string): CourseTree | null {
  const course = getCourse(db, id);
  if (!course) return null;
  const modules = db
    .prepare(`SELECT * FROM tudor_modules WHERE course_id = ? ORDER BY idx`)
    .all(id) as ModuleRow[];
  const progressRows = db
    .prepare(`SELECT * FROM tudor_progress WHERE course_id = ?`)
    .all(id) as ProgressRow[];
  const progress = new Map(progressRows.map((p) => [p.lesson_id, p]));

  const tree: CourseTree['modules'] = modules.map((m) => {
    const lessons = db
      .prepare(`SELECT * FROM tudor_lessons WHERE module_id = ? ORDER BY idx`)
      .all(m.id) as LessonRow[];
    return {
      ...m,
      lessons: lessons.map((l) => {
        const segments = db
          .prepare(`SELECT * FROM tudor_segments WHERE lesson_id = ? ORDER BY idx`)
          .all(l.id) as SegmentRow[];
        const quizzes = db
          .prepare(`SELECT * FROM tudor_quizzes WHERE lesson_id = ? ORDER BY idx`)
          .all(l.id) as QuizRow[];
        const p = progress.get(l.id);
        return {
          ...l,
          segments,
          quizzes,
          progress: (p?.state ?? 'unseen') as ProgressState,
          confidence: p?.confidence ?? 0,
        };
      }),
    };
  });
  return { course, job: getJob(db, id), modules: tree };
}

export function upsertProgress(
  db: DB,
  courseId: string,
  lessonId: string,
  state: ProgressState,
  confidence: number,
): void {
  db.prepare(
    `INSERT INTO tudor_progress (course_id, lesson_id, state, confidence, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(course_id, lesson_id) DO UPDATE SET
       state = excluded.state, confidence = excluded.confidence, updated_at = excluded.updated_at`,
  ).run(courseId, lessonId, state, Math.max(0, Math.min(3, Math.round(confidence))), Date.now());
}

export function deleteCourse(db: DB, id: string): void {
  // Children cascade via ON DELETE CASCADE (foreign_keys is ON on the shared DB).
  db.prepare(`DELETE FROM tudor_courses WHERE id = ?`).run(id);
}

export function getSegment(db: DB, segmentId: string): SegmentRow | null {
  return (
    (db.prepare(`SELECT * FROM tudor_segments WHERE id = ?`).get(segmentId) as SegmentRow) ?? null
  );
}

export function lessonTitleForSegment(db: DB, segmentId: string): string {
  const row = db
    .prepare(
      `SELECT l.title AS title FROM tudor_segments s
       JOIN tudor_lessons l ON l.id = s.lesson_id WHERE s.id = ?`,
    )
    .get(segmentId) as { title: string } | undefined;
  return row?.title ?? '';
}

export function setSegmentVariants(
  db: DB,
  segmentId: string,
  variants: Record<string, string>,
): void {
  db.prepare(`UPDATE tudor_segments SET variants_json = ? WHERE id = ?`).run(
    JSON.stringify(variants),
    segmentId,
  );
}

// Read any extension's setting straight from the shared core table. Lets the
// frontend (which has no host.settings) read a user's defaults — including a
// sibling extension's, e.g. gurney-websearch's confirm-before-search flag.
export function readExtSettingFor(
  db: DB,
  extension: string,
  key: string,
  fallback: string,
): string {
  const row = db
    .prepare(`SELECT value FROM extension_settings WHERE extension = ? AND key = ?`)
    .get(extension, key) as { value: string } | undefined;
  return row?.value ?? fallback;
}

export function readExtSetting(db: DB, key: string, fallback: string): string {
  return readExtSettingFor(db, 'gurney-tudor', key, fallback);
}

export function isExtensionEnabled(db: DB, name: string): boolean {
  const row = db.prepare(`SELECT enabled FROM extension_state WHERE name = ?`).get(name) as
    | { enabled: number }
    | undefined;
  return !!row && row.enabled !== 0;
}
