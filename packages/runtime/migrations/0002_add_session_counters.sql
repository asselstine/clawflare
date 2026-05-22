-- Migration 0002: Add per-session sequence counters
-- Supports safe queue/event sequence reservation for existing D1 databases

CREATE TABLE IF NOT EXISTS session_counters (
  session_id TEXT PRIMARY KEY,
  next_queue_sequence INTEGER NOT NULL DEFAULT 1,
  next_event_sequence INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
) STRICT;

INSERT OR IGNORE INTO session_counters (
  session_id,
  next_queue_sequence,
  next_event_sequence,
  updated_at
)
SELECT
  s.id,
  COALESCE((SELECT MAX(q.sequence) + 1 FROM session_input_queue q WHERE q.session_id = s.id), 1),
  COALESCE((SELECT MAX(e.sequence) + 1 FROM session_events e WHERE e.session_id = s.id), 1),
  s.updated_at
FROM sessions s;
