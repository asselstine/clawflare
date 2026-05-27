-- Migration: Create job_authorization_snapshots table for async workflow authorization

CREATE TABLE IF NOT EXISTS job_authorization_snapshots (
    job_id TEXT PRIMARY KEY,
    created_by_user_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    allowed_operations TEXT NOT NULL,        -- JSON array of allowed operations
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,             -- Authorization expires at this time
    authorization_version INTEGER NOT NULL,  -- Version for forward compatibility
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
);

-- Index for cleanup of expired snapshots
CREATE INDEX IF NOT EXISTS idx_job_auth_expires
    ON job_authorization_snapshots(expires_at);

-- Index for workspace lookups
CREATE INDEX IF NOT EXISTS idx_job_auth_workspace
    ON job_authorization_snapshots(workspace_id, created_at);
