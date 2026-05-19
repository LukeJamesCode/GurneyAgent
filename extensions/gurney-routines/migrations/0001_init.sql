-- gurney-routines 0001: learned routine candidates, user-visible suggestions,
-- accepted rules, and delivery/audit events.

CREATE TABLE routine_candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pattern_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  proposed_cron TEXT NOT NULL,
  proposed_text TEXT NOT NULL,
  confidence REAL NOT NULL,
  evidence_json TEXT NOT NULL,
  source_extensions TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate', 'suggested', 'accepted', 'dismissed')),
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_routine_candidates_status_confidence ON routine_candidates (status, confidence, updated_at);

CREATE TABLE routine_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id INTEGER REFERENCES routine_candidates(id) ON DELETE SET NULL,
  chat_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  cron TEXT NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'deleted')),
  source_extensions TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_routine_rules_status ON routine_rules (status, chat_id);

CREATE TABLE routine_suggestions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id INTEGER NOT NULL REFERENCES routine_candidates(id) ON DELETE CASCADE,
  chat_id INTEGER NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'dismissed', 'expired')),
  sent_at INTEGER NOT NULL,
  responded_at INTEGER
);

CREATE INDEX idx_routine_suggestions_chat_status ON routine_suggestions (chat_id, status, sent_at);
CREATE INDEX idx_routine_suggestions_candidate ON routine_suggestions (candidate_id, sent_at);

CREATE TABLE routine_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_id INTEGER REFERENCES routine_rules(id) ON DELETE SET NULL,
  candidate_id INTEGER REFERENCES routine_candidates(id) ON DELETE SET NULL,
  chat_id INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  detail TEXT,
  event_at INTEGER NOT NULL
);

CREATE INDEX idx_routine_events_rule_time ON routine_events (rule_id, event_at);
CREATE INDEX idx_routine_events_type_time ON routine_events (event_type, event_at);
