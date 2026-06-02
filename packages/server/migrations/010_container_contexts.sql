-- Trusted mapping from Cloudflare container identity to owning session/workspace.

CREATE TABLE IF NOT EXISTS container_contexts (
  container_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS idx_container_contexts_session
  ON container_contexts(session_id);

CREATE INDEX IF NOT EXISTS idx_container_contexts_workspace
  ON container_contexts(workspace_id);
