CREATE TABLE session_runs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  workspace_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('runnable', 'running', 'completed', 'error', 'cancel_requested', 'cancelled')),
  input_json TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  step_cursor INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX idx_session_runs_session_status
  ON session_runs(session_id, status);

CREATE INDEX idx_session_runs_status_updated
  ON session_runs(status, updated_at);

CREATE INDEX idx_session_runs_lease
  ON session_runs(status, lease_expires_at);

CREATE TABLE session_run_steps (
  run_id TEXT NOT NULL,
  step_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('completed')),
  result_json TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, step_name),
  FOREIGN KEY (run_id) REFERENCES session_runs(id) ON DELETE CASCADE
);
