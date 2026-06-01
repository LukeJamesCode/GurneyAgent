-- gurney-tudor 0001_tudor
-- The course data model for the guided-learning studio. A "course" is compiled
-- once from a topic (the slow, expensive step) into a tree of modules ->
-- lessons -> segments + quizzes. Consumption (stepping through, quizzing,
-- reviewing) then reads these tables with zero model calls, which is how the
-- 40-60s local-inference latency is hidden from the learner.
--
-- All ids are TEXT uuids so the browser can route to them directly. Children
-- cascade-delete with their course (the shared DB runs with foreign_keys = ON).

CREATE TABLE IF NOT EXISTS tudor_courses (
  id          TEXT    PRIMARY KEY,
  topic       TEXT    NOT NULL,                 -- the learner's prompt
  title       TEXT,                             -- model-generated, set after the outline
  status      TEXT    NOT NULL DEFAULT 'generating', -- 'generating' | 'ready' | 'failed'
  model       TEXT,                             -- which model/profile compiled it
  depth       TEXT    NOT NULL DEFAULT 'standard',   -- 'quick' | 'standard' | 'deep'
  created_at  INTEGER NOT NULL,
  ready_at    INTEGER
);

CREATE TABLE IF NOT EXISTS tudor_modules (
  id          TEXT    PRIMARY KEY,
  course_id   TEXT    NOT NULL REFERENCES tudor_courses(id) ON DELETE CASCADE,
  idx         INTEGER NOT NULL,                 -- order within the course
  title       TEXT    NOT NULL,
  summary     TEXT
);
CREATE INDEX IF NOT EXISTS idx_tudor_modules_course ON tudor_modules (course_id, idx);

CREATE TABLE IF NOT EXISTS tudor_lessons (
  id          TEXT    PRIMARY KEY,
  module_id   TEXT    NOT NULL REFERENCES tudor_modules(id) ON DELETE CASCADE,
  idx         INTEGER NOT NULL,
  title       TEXT    NOT NULL,
  status      TEXT    NOT NULL DEFAULT 'pending', -- 'pending' | 'generating' | 'ready' | 'failed'
  est_minutes INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tudor_lessons_module ON tudor_lessons (module_id, idx);

-- A segment is one "slide": a short, single-idea chunk the player reveals one
-- at a time. `narration` is reserved for phase-2 voice-over. `variants_json`
-- caches on-demand "explain simpler / go deeper" rewrites so a repeat is instant.
CREATE TABLE IF NOT EXISTS tudor_segments (
  id            TEXT    PRIMARY KEY,
  lesson_id     TEXT    NOT NULL REFERENCES tudor_lessons(id) ON DELETE CASCADE,
  idx           INTEGER NOT NULL,
  kind          TEXT    NOT NULL,               -- explain | example | analogy | keypoints | checkpoint | warning
  body_md       TEXT    NOT NULL,
  narration     TEXT,
  variants_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_tudor_segments_lesson ON tudor_segments (lesson_id, idx);

CREATE TABLE IF NOT EXISTS tudor_quizzes (
  id           TEXT    PRIMARY KEY,
  lesson_id    TEXT    NOT NULL REFERENCES tudor_lessons(id) ON DELETE CASCADE,
  idx          INTEGER NOT NULL,
  question     TEXT    NOT NULL,
  choices_json TEXT    NOT NULL,                -- JSON array of option strings
  answer_idx   INTEGER NOT NULL,                -- 0-based index into choices
  explain_md   TEXT
);
CREATE INDEX IF NOT EXISTS idx_tudor_quizzes_lesson ON tudor_quizzes (lesson_id, idx);

-- Per-lesson learner progress. confidence is a 0-3 self-rating that fills the
-- mastery map. Single owner for v1, so no chat/user key (mirrors how the panel
-- treats its direct chat as the owner).
CREATE TABLE IF NOT EXISTS tudor_progress (
  course_id   TEXT    NOT NULL REFERENCES tudor_courses(id) ON DELETE CASCADE,
  lesson_id   TEXT    NOT NULL,
  state       TEXT    NOT NULL DEFAULT 'unseen', -- 'unseen' | 'in_progress' | 'done'
  confidence  INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (course_id, lesson_id)
);

-- One row per course tracks generation progress so the panel can render a live
-- "Module 2 of 5 ready" bar, and so a reload can tell a finished course from an
-- in-flight one.
CREATE TABLE IF NOT EXISTS tudor_jobs (
  course_id   TEXT    PRIMARY KEY REFERENCES tudor_courses(id) ON DELETE CASCADE,
  phase       TEXT    NOT NULL DEFAULT 'outline', -- 'outline' | 'lessons'
  done        INTEGER NOT NULL DEFAULT 0,
  total       INTEGER NOT NULL DEFAULT 0,
  error       TEXT,
  updated_at  INTEGER NOT NULL
);
