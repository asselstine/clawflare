-- Clawflare Initial Schema
-- Consolidated migration: sessions, events, queues, runtime, stored code, egress handlers,
-- auth (users, workspaces, memberships, OAuth accounts, tokens, device auth, web sessions,
-- access tokens, email verification, password reset), and model connections.

PRAGMA foreign_keys = ON;

-- =============================================================================
-- Users
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
-- Workspaces
-- =============================================================================
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  default_model_connection_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_workspaces_slug ON workspaces(slug);
CREATE INDEX idx_workspaces_updated ON workspaces(updated_at DESC);

-- =============================================================================
-- Workspace Memberships
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
-- OAuth Accounts
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
-- Password Credentials
-- =============================================================================
CREATE TABLE password_credentials (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  password_hash TEXT NOT NULL,
  password_updated_at INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_password_credentials_updated ON password_credentials(password_updated_at);

-- =============================================================================
-- Web Sessions
-- =============================================================================
CREATE TABLE web_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_token_hash TEXT NOT NULL UNIQUE,
  csrf_token_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER
) STRICT;

CREATE INDEX idx_web_sessions_user_id ON web_sessions(user_id);
CREATE INDEX idx_web_sessions_token_hash ON web_sessions(session_token_hash);
CREATE INDEX idx_web_sessions_expires_at ON web_sessions(expires_at);

-- =============================================================================
-- Access Tokens
-- =============================================================================
CREATE TABLE access_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  client_name TEXT,
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
) STRICT;

CREATE INDEX idx_access_tokens_user_id ON access_tokens(user_id);
CREATE INDEX idx_access_tokens_token_hash ON access_tokens(token_hash);
CREATE INDEX idx_access_tokens_revoked ON access_tokens(revoked_at);

-- =============================================================================
-- Device Authorizations
-- =============================================================================
CREATE TABLE device_authorizations (
  device_code TEXT PRIMARY KEY,
  user_code TEXT NOT NULL UNIQUE,
  client_name TEXT NOT NULL,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  access_token_id TEXT REFERENCES access_tokens(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'expired')),
  expires_at INTEGER NOT NULL,
  approved_at INTEGER,
  created_at INTEGER NOT NULL,
  oauth_state_hash TEXT,
  access_token_plaintext TEXT,
  token_retrieved_at INTEGER
) STRICT;

CREATE INDEX idx_device_authorizations_user_code ON device_authorizations(user_code);
CREATE INDEX idx_device_authorizations_user_id ON device_authorizations(user_id);
CREATE INDEX idx_device_authorizations_expires_at ON device_authorizations(expires_at);
CREATE INDEX idx_device_authorizations_status ON device_authorizations(status);
CREATE INDEX idx_device_authorizations_oauth_state_hash ON device_authorizations(oauth_state_hash);

-- =============================================================================
-- Email Verification Tokens
-- =============================================================================
CREATE TABLE email_verification_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  created_at INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_email_verification_tokens_user_id ON email_verification_tokens(user_id);
CREATE INDEX idx_email_verification_tokens_hash ON email_verification_tokens(token_hash);

-- =============================================================================
-- Password Reset Tokens
-- =============================================================================
CREATE TABLE password_reset_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  created_at INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_password_reset_tokens_user_id ON password_reset_tokens(user_id);
CREATE INDEX idx_password_reset_tokens_hash ON password_reset_tokens(token_hash);

-- =============================================================================
-- Sessions
-- =============================================================================
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  workspace_id TEXT,
  status TEXT NOT NULL CHECK (
    status IN ('idle', 'processing', 'awaiting_input', 'error', 'closed', 'expired')
  ),
  next_event_cursor INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  error_message TEXT,
  max_queue_size INTEGER NOT NULL DEFAULT 100,
  idle_timeout TEXT,
  model_connection_id TEXT,
  model_provider TEXT,
  model_name TEXT
) STRICT;

CREATE INDEX idx_sessions_status_updated ON sessions(status, updated_at DESC);
CREATE INDEX idx_sessions_updated ON sessions(updated_at DESC);
CREATE INDEX idx_sessions_workflow ON sessions(workflow_id);
CREATE INDEX idx_sessions_workspace ON sessions(workspace_id);
CREATE INDEX idx_sessions_workspace_updated ON sessions(workspace_id, updated_at DESC);

-- =============================================================================
-- Session Events
-- =============================================================================
CREATE TABLE session_events (
  session_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  workspace_id TEXT,
  timestamp INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (session_id, sequence),
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
) STRICT;

CREATE INDEX idx_session_events_session_sequence ON session_events(session_id, sequence);
CREATE INDEX idx_session_events_type ON session_events(type);
CREATE INDEX idx_session_events_timestamp ON session_events(timestamp);
CREATE INDEX idx_session_events_workspace ON session_events(workspace_id);
CREATE INDEX idx_session_events_workspace_session ON session_events(workspace_id, session_id);

-- =============================================================================
-- Session Counters
-- =============================================================================
CREATE TABLE session_counters (
  session_id TEXT PRIMARY KEY,
  workspace_id TEXT,
  next_queue_sequence INTEGER NOT NULL DEFAULT 1,
  next_event_sequence INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
) STRICT;

CREATE INDEX idx_session_counters_workspace ON session_counters(workspace_id);

-- =============================================================================
-- Session Input Queue
-- =============================================================================
CREATE TABLE session_input_queue (
  session_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  workspace_id TEXT,
  event_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, sequence),
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
) STRICT;

CREATE INDEX idx_session_input_queue_session_sequence ON session_input_queue(session_id, sequence);
CREATE INDEX idx_session_input_queue_workspace ON session_input_queue(workspace_id);

-- =============================================================================
-- Session Runtime State
-- =============================================================================
CREATE TABLE session_runtime (
  session_id TEXT PRIMARY KEY,
  workspace_id TEXT,
  active INTEGER NOT NULL DEFAULT 0,
  workflow_session_json TEXT,
  snapshot_json TEXT,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
) STRICT;

CREATE INDEX idx_session_runtime_active ON session_runtime(active);
CREATE INDEX idx_session_runtime_workspace ON session_runtime(workspace_id);

-- =============================================================================
-- Container Contexts
-- =============================================================================
CREATE TABLE container_contexts (
  container_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
) STRICT;

CREATE INDEX idx_container_contexts_session ON container_contexts(session_id);
CREATE INDEX idx_container_contexts_workspace ON container_contexts(workspace_id);

-- =============================================================================
-- Stored Code (workspace-scoped)
-- =============================================================================
CREATE TABLE stored_code (
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

CREATE INDEX idx_stored_code_workspace_updated ON stored_code(workspace_id, updated_at DESC);
CREATE INDEX idx_stored_code_workspace_name ON stored_code(workspace_id, name);

-- =============================================================================
-- Egress Handlers
-- =============================================================================
CREATE TABLE egress_handlers (
  workspace_id TEXT NOT NULL,
  egress_handler_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  domains_json TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  secret_refs_json TEXT NOT NULL DEFAULT '{}',
  config_json TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, egress_handler_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
) STRICT;

CREATE INDEX idx_egress_handlers_enabled ON egress_handlers(enabled);
CREATE INDEX idx_egress_handlers_id ON egress_handlers(egress_handler_id);
CREATE INDEX idx_egress_handlers_name ON egress_handlers(name);
CREATE INDEX idx_egress_handlers_updated ON egress_handlers(updated_at DESC);
CREATE INDEX idx_egress_handlers_workspace ON egress_handlers(workspace_id);
CREATE INDEX idx_egress_handlers_workspace_enabled ON egress_handlers(workspace_id, enabled);

-- =============================================================================
-- Model Connections
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

CREATE INDEX idx_model_connections_workspace
  ON model_connections(workspace_id, deleted_at, updated_at DESC);
CREATE INDEX idx_model_connections_provider
  ON model_connections(provider, model_name);
