-- gurney-tudor 0003_tudor_segment_images
-- One verified image per lesson segment. Candidates come from the same web
-- pages used for course research, and a multimodal local model approves them
-- before insertion.

CREATE TABLE IF NOT EXISTS tudor_segment_images (
  id          TEXT    PRIMARY KEY,
  segment_id  TEXT    NOT NULL REFERENCES tudor_segments(id) ON DELETE CASCADE,
  source_url  TEXT    NOT NULL,
  image_url   TEXT    NOT NULL,
  alt_text    TEXT,
  caption     TEXT,
  verified_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tudor_segment_images_segment
  ON tudor_segment_images (segment_id);

