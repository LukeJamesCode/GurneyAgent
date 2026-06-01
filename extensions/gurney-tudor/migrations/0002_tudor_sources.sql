-- gurney-tudor 0002_tudor_sources
-- The web sources a course was researched from. One row per approved website,
-- so the Learn tab can show "websites used for this topic" and so a course
-- carries a record of where its facts came from. Populated only when web
-- research ran for the course; cascade-deleted with it.

CREATE TABLE IF NOT EXISTS tudor_sources (
  id          TEXT    PRIMARY KEY,
  course_id   TEXT    NOT NULL REFERENCES tudor_courses(id) ON DELETE CASCADE,
  idx         INTEGER NOT NULL,
  title       TEXT    NOT NULL,
  url         TEXT    NOT NULL,
  domain      TEXT
);
CREATE INDEX IF NOT EXISTS idx_tudor_sources_course ON tudor_sources (course_id, idx);
