-- Migration: Add workflow_auth_job_id to sessions table
-- Used for async job authorization in workflows

ALTER TABLE sessions ADD COLUMN workflow_auth_job_id TEXT;

-- Index for looking up sessions by job authorization
CREATE INDEX IF NOT EXISTS idx_sessions_workflow_auth_job_id 
    ON sessions(workflow_auth_job_id) 
    WHERE workflow_auth_job_id IS NOT NULL;
