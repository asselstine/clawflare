-- Migration 0004: Complete Workspace Migration
-- Drops old stored_code table and adds final constraints

PRAGMA foreign_keys = ON;

-- Drop old stored_code table (data migrated in 0003)
DROP TABLE IF EXISTS stored_code;

-- Rename stored_code_v2 to stored_code
ALTER TABLE stored_code_v2 RENAME TO stored_code;

-- Add indexes on the renamed table
CREATE INDEX idx_stored_code_workspace_updated ON stored_code(workspace_id, updated_at DESC);
CREATE INDEX idx_stored_code_workspace_name ON stored_code(workspace_id, name);

-- Add NOT NULL constraints where appropriate (after data migration)
-- Note: SQLite doesn't allow adding NOT NULL to existing columns via ALTER
-- These constraints would be enforced by application code

-- =============================================================================
-- Migration complete - workspace scoping fully active
-- =============================================================================
