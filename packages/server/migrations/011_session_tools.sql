-- Persist the active tool refs attached to each session.

CREATE TABLE IF NOT EXISTS session_tools (
  session_id TEXT NOT NULL,
  tool_ref_type TEXT NOT NULL CHECK (tool_ref_type IN ('builtin', 'custom')),
  tool_ref TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  config_json TEXT NOT NULL DEFAULT '{}',
  pinned_version_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, tool_ref_type, tool_ref),
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS idx_session_tools_session_enabled
  ON session_tools(session_id, enabled);
