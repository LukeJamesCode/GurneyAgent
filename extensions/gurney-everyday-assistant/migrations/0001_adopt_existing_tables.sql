-- gurney-everyday-assistant 0001_adopt_existing_tables
-- Idempotent: safe on fresh installs and on installs migrating from the 5 old extensions.

-- Reminders table (inherited from gurney-reminders 0001_init).
-- CREATE TABLE IF NOT EXISTS is safe when rows already exist.
CREATE TABLE IF NOT EXISTS reminders (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id    INTEGER NOT NULL,
  text       TEXT    NOT NULL,
  fire_at    INTEGER NOT NULL,
  fired      INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reminders_sweep ON reminders (fired, fire_at);

-- Calendar nudge dedup table (inherited from gurney-google-calendar 0001+0002).
-- Uses the post-0002 chat-aware schema directly.
CREATE TABLE IF NOT EXISTS calendar_nudges_sent (
  event_id    TEXT    NOT NULL,
  fire_minute INTEGER NOT NULL,
  chat_id     INTEGER NOT NULL,
  sent_at     INTEGER NOT NULL,
  PRIMARY KEY (event_id, fire_minute, chat_id)
);
CREATE INDEX IF NOT EXISTS idx_calendar_nudges_recent ON calendar_nudges_sent (sent_at);

-- Settings migration: copy rows from the 5 old extensions into this one.
-- INSERT OR IGNORE preserves any value already set (e.g. calendar wins over tasks
-- for shared google_client_id when both existed).

-- From gurney-google-calendar
INSERT OR IGNORE INTO extension_settings (extension, key, value, updated_at)
  SELECT 'gurney-everyday-assistant', 'google_client_id', value, updated_at
  FROM extension_settings WHERE extension = 'gurney-google-calendar' AND key = 'client_id';

INSERT OR IGNORE INTO extension_settings (extension, key, value, updated_at)
  SELECT 'gurney-everyday-assistant', 'google_client_secret', value, updated_at
  FROM extension_settings WHERE extension = 'gurney-google-calendar' AND key = 'client_secret';

-- The calendar refresh_token only has calendar scope.
-- Copy it so the extension starts working immediately for calendar.
-- NOTE: Tasks calls will 401 until the user re-runs `gurney auth gurney-everyday-assistant`
-- to get a combined-scope token. prompt.md contains the one-time banner.
INSERT OR IGNORE INTO extension_settings (extension, key, value, updated_at)
  SELECT 'gurney-everyday-assistant', 'google_refresh_token', value, updated_at
  FROM extension_settings WHERE extension = 'gurney-google-calendar' AND key = 'refresh_token';

INSERT OR IGNORE INTO extension_settings (extension, key, value, updated_at)
  SELECT 'gurney-everyday-assistant', 'calendar_id', value, updated_at
  FROM extension_settings WHERE extension = 'gurney-google-calendar' AND key = 'calendar_id';

INSERT OR IGNORE INTO extension_settings (extension, key, value, updated_at)
  SELECT 'gurney-everyday-assistant', 'nudge_lookahead_minutes', value, updated_at
  FROM extension_settings WHERE extension = 'gurney-google-calendar' AND key = 'nudge_lookahead_minutes';

INSERT OR IGNORE INTO extension_settings (extension, key, value, updated_at)
  SELECT 'gurney-everyday-assistant', 'nudge_chat_id', value, updated_at
  FROM extension_settings WHERE extension = 'gurney-google-calendar' AND key = 'nudge_chat_id';

-- From gurney-google-tasks (INSERT OR IGNORE keeps calendar values if already set)
INSERT OR IGNORE INTO extension_settings (extension, key, value, updated_at)
  SELECT 'gurney-everyday-assistant', 'google_client_id', value, updated_at
  FROM extension_settings WHERE extension = 'gurney-google-tasks' AND key = 'client_id';

INSERT OR IGNORE INTO extension_settings (extension, key, value, updated_at)
  SELECT 'gurney-everyday-assistant', 'google_client_secret', value, updated_at
  FROM extension_settings WHERE extension = 'gurney-google-tasks' AND key = 'client_secret';

-- Do NOT copy tasks's refresh_token — wrong scope. Re-auth will replace it.

INSERT OR IGNORE INTO extension_settings (extension, key, value, updated_at)
  SELECT 'gurney-everyday-assistant', 'default_tasklist', value, updated_at
  FROM extension_settings WHERE extension = 'gurney-google-tasks' AND key = 'default_tasklist';

-- From gurney-weather
INSERT OR IGNORE INTO extension_settings (extension, key, value, updated_at)
  SELECT 'gurney-everyday-assistant', 'default_location', value, updated_at
  FROM extension_settings WHERE extension = 'gurney-weather' AND key = 'default_location';

-- From gurney-briefing
INSERT OR IGNORE INTO extension_settings (extension, key, value, updated_at)
  SELECT 'gurney-everyday-assistant', 'morning_cron', value, updated_at
  FROM extension_settings WHERE extension = 'gurney-briefing' AND key = 'morning_cron';

INSERT OR IGNORE INTO extension_settings (extension, key, value, updated_at)
  SELECT 'gurney-everyday-assistant', 'night_cron', value, updated_at
  FROM extension_settings WHERE extension = 'gurney-briefing' AND key = 'night_cron';

INSERT OR IGNORE INTO extension_settings (extension, key, value, updated_at)
  SELECT 'gurney-everyday-assistant', 'time_zone', value, updated_at
  FROM extension_settings WHERE extension = 'gurney-briefing' AND key = 'time_zone';

INSERT OR IGNORE INTO extension_settings (extension, key, value, updated_at)
  SELECT 'gurney-everyday-assistant', 'include_weather', value, updated_at
  FROM extension_settings WHERE extension = 'gurney-briefing' AND key = 'include_weather';

INSERT OR IGNORE INTO extension_settings (extension, key, value, updated_at)
  SELECT 'gurney-everyday-assistant', 'include_calendar', value, updated_at
  FROM extension_settings WHERE extension = 'gurney-briefing' AND key = 'include_calendar';

INSERT OR IGNORE INTO extension_settings (extension, key, value, updated_at)
  SELECT 'gurney-everyday-assistant', 'include_tasks', value, updated_at
  FROM extension_settings WHERE extension = 'gurney-briefing' AND key = 'include_tasks';

-- briefing's chat_id → briefing_chat_id (to avoid shadowing nudge_chat_id)
INSERT OR IGNORE INTO extension_settings (extension, key, value, updated_at)
  SELECT 'gurney-everyday-assistant', 'briefing_chat_id', value, updated_at
  FROM extension_settings WHERE extension = 'gurney-briefing' AND key = 'chat_id';

-- briefing's weather_location → default_location (INSERT OR IGNORE keeps weather's value if set)
INSERT OR IGNORE INTO extension_settings (extension, key, value, updated_at)
  SELECT 'gurney-everyday-assistant', 'default_location', value, updated_at
  FROM extension_settings WHERE extension = 'gurney-briefing' AND key = 'weather_location';

-- Clean up old extension rows so `gurney ext list` / `gurney config` don't show ghosts.
DELETE FROM extension_settings WHERE extension IN (
  'gurney-google-calendar',
  'gurney-google-tasks',
  'gurney-reminders',
  'gurney-weather',
  'gurney-briefing'
);
