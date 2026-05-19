-- gurney-tts 0001_init: per-chat voice preference. One row per chat the user
-- has touched /voice for; the after-reply hook reads this table to decide
-- whether to synthesize.

CREATE TABLE tts_chat_prefs (
  chat_id INTEGER PRIMARY KEY,
  enabled INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
