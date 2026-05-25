-- gurney-speaker schema. Tracks the small amount of per-device state that
-- needs to survive a Gurney restart: which device IDs are known, what label
-- was assigned to them, when we last saw them, and the last volume/mute the
-- device reported (so we can push it back on reconnect instead of reverting
-- to the default).

CREATE TABLE IF NOT EXISTS speaker_devices (
  device_id    TEXT PRIMARY KEY,
  label        TEXT,
  last_seen    INTEGER NOT NULL DEFAULT 0,
  last_volume  REAL NOT NULL DEFAULT 0.6,
  muted        INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
);

CREATE INDEX IF NOT EXISTS idx_speaker_devices_last_seen
  ON speaker_devices(last_seen);
