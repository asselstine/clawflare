-- Migration 0007: Model Connections
-- Workspace-scoped AI model connections with Secret Store integration

PRAGMA foreign_keys = ON;

-- =============================================================================
-- Model Connections Table
-- Stores workspace-scoped AI model configuration with Secret Store references
-- =============================================================================

CREATE TABLE model_connections (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  display_name TEXT,
  provider TEXT NOT NULL,
  model_name TEXT NOT NULL,
  secret_refs_json TEXT NOT NULL DEFAULT '{}',
  config_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
) STRICT;

-- Indexes for workspace lookups and filtering
CREATE INDEX idx_model_connections_workspace
  ON model_connections(workspace_id, deleted_at, updated_at DESC);
CREATE INDEX idx_model_connections_provider
  ON model_connections(provider, model_name);

-- =============================================================================
-- Workspaces Table - Add default model connection
-- =============================================================================

ALTER TABLE workspaces ADD COLUMN default_model_connection_id TEXT;

-- =============================================================================
-- Sessions Table - Add model connection fields for immutable session model
-- =============================================================================

ALTER TABLE sessions ADD COLUMN model_connection_id TEXT;
ALTER TABLE sessions ADD COLUMN model_provider TEXT;
ALTER TABLE sessions ADD COLUMN model_name TEXT;

-- Migration complete - model connections schema ready
