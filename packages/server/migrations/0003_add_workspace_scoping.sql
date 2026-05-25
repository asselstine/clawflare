-- Migration 0003: Add Workspace Scoping for Multi-Tenant Data Access
-- Creates user/workspace tables and adds workspace_id to user-owned tables

PRAGMA foreign_keys = ON;

-- =============================================================================
-- Users Table
-- =============================================================================

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_users_email ON users(email);

-- =============================================================================
-- Workspaces Table
-- =============================================================================

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_workspaces_slug ON workspaces(slug);
CREATE INDEX idx_workspaces_updated ON workspaces(updated_at DESC);

-- =============================================================================
-- Workspace Memberships Table
-- =============================================================================

CREATE TABLE workspace_memberships (
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  joined_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, user_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) STRICT;

CREATE INDEX idx_workspace_memberships_user ON workspace_memberships(user_id);
CREATE INDEX idx_workspace_memberships_workspace ON workspace_memberships(workspace_id);

-- =============================================================================
-- OAuth Accounts Table
-- =============================================================================

CREATE TABLE oauth_accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_account_id TEXT NOT NULL,
  access_token TEXT,
  refresh_token TEXT,
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(user_id, provider),
  UNIQUE(provider, provider_account_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) STRICT;

CREATE INDEX idx_oauth_accounts_user ON oauth_accounts(user_id);
CREATE INDEX idx_oauth_accounts_provider ON oauth_accounts(provider, provider_account_id);

-- =============================================================================
-- CLI Tokens Table
-- =============================================================================

CREATE TABLE cli_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  name TEXT,
  last_used_at INTEGER,
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) STRICT;

CREATE INDEX idx_cli_tokens_user ON cli_tokens(user_id);
CREATE INDEX idx_cli_tokens_hash ON cli_tokens(token_hash);

-- =============================================================================
-- Add workspace_id to Sessions Table
-- =============================================================================

ALTER TABLE sessions ADD COLUMN workspace_id TEXT;
CREATE INDEX idx_sessions_workspace ON sessions(workspace_id);
CREATE INDEX idx_sessions_workspace_updated ON sessions(workspace_id, updated_at DESC);

-- =============================================================================
-- Add workspace_id to Session Events Table
-- =============================================================================

ALTER TABLE session_events ADD COLUMN workspace_id TEXT;
CREATE INDEX idx_session_events_workspace ON session_events(workspace_id);
CREATE INDEX idx_session_events_workspace_session ON session_events(workspace_id, session_id);

-- =============================================================================
-- Add workspace_id to Session Counters Table
-- =============================================================================

ALTER TABLE session_counters ADD COLUMN workspace_id TEXT;
CREATE INDEX idx_session_counters_workspace ON session_counters(workspace_id);

-- =============================================================================
-- Add workspace_id to Session Input Queue Table
-- =============================================================================

ALTER TABLE session_input_queue ADD COLUMN workspace_id TEXT;
CREATE INDEX idx_session_input_queue_workspace ON session_input_queue(workspace_id);

-- =============================================================================
-- Add workspace_id to Session Runtime Table
-- =============================================================================

ALTER TABLE session_runtime ADD COLUMN workspace_id TEXT;
CREATE INDEX idx_session_runtime_workspace ON session_runtime(workspace_id);

-- =============================================================================
-- Migrate Stored Code to Workspace-Scoped (composite key)
-- =============================================================================

-- Create new workspace-scoped stored_code table
CREATE TABLE stored_code_v2 (
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  code TEXT NOT NULL,
  description TEXT,
  tags_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, name),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
) STRICT;

-- Migrate existing data to default workspace (will be setup with a trigger)
-- CREATE INDEX idx_stored_code_v2_workspace_updated ON stored_code_v2(workspace_id, updated_at DESC);
-- CREATE INDEX idx_stored_code_v2_workspace_name ON stored_code_v2(workspace_id, name);

-- Note: We keep the old stored_code table for backward compatibility during migration
-- A separate migration (0004) will drop it after data migration

-- =============================================================================
-- Add workspace_id to Egress Handlers Table
-- =============================================================================

ALTER TABLE egress_handlers ADD COLUMN workspace_id TEXT;
CREATE INDEX idx_egress_handlers_workspace ON egress_handlers(workspace_id);
CREATE INDEX idx_egress_handlers_workspace_enabled ON egress_handlers(workspace_id, enabled);

-- =============================================================================
-- Create default workspace for existing data
-- =============================================================================

INSERT INTO workspaces (id, slug, name, description, created_at, updated_at)
VALUES (
  'default-workspace',
  'default',
  'Default Workspace',
  'Auto-created default workspace for existing sessions',
  strftime('%s', 'now') * 1000,
  strftime('%s', 'now') * 1000
);

-- Update all existing sessions to use default workspace
UPDATE sessions SET workspace_id = 'default-workspace' WHERE workspace_id IS NULL;
UPDATE session_events SET workspace_id = 'default-workspace' WHERE workspace_id IS NULL;
UPDATE session_counters SET workspace_id = 'default-workspace' WHERE workspace_id IS NULL;
UPDATE session_input_queue SET workspace_id = 'default-workspace' WHERE workspace_id IS NULL;
UPDATE session_runtime SET workspace_id = 'default-workspace' WHERE workspace_id IS NULL;

-- Migrate stored_code to v2 with default workspace
INSERT INTO stored_code_v2 (workspace_id, name, code, description, tags_json, created_at, updated_at)
SELECT 
  'default-workspace' as workspace_id,
  name,
  code,
  description,
  tags_json,
  created_at,
  updated_at
FROM stored_code;

-- Migrate egress_handlers to use default workspace
UPDATE egress_handlers SET workspace_id = 'default-workspace' WHERE workspace_id IS NULL;

-- =============================================================================
-- Migration complete - workspace scoping infrastructure ready
-- =============================================================================
