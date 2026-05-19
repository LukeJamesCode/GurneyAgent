-- gurney-memgraph 0001_init: bookkeeping for the background extraction sweep.
-- The bridge owns the actual graph; we just track which messages we've already
-- shipped to it so a restart doesn't double-extract.

CREATE TABLE memgraph_sync_state (
  conversation_id INTEGER PRIMARY KEY,
  last_message_id INTEGER NOT NULL DEFAULT 0,
  last_synced_at INTEGER NOT NULL
);
