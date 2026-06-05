-- Clawflare Initial Schema
-- Consolidated migration: sessions, events, queues, runtime, stored code, egress handlers,
-- auth (users, workspaces, memberships, OAuth accounts, tokens, device auth, web sessions,
-- access tokens, email verification, password reset), and models.

PRAGMA foreign_keys = ON;

-- =============================================================================
-- Users
-- =============================================================================
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT,
  email_verified_at INTEGER,
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
  default_model_id TEXT,
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
  return_url TEXT,
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
  name TEXT,
  status TEXT NOT NULL CHECK (
    status IN ('idle', 'processing', 'awaiting_input', 'error', 'closed', 'expired')
  ),
  next_event_cursor INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  error_message TEXT,
  max_queue_size INTEGER NOT NULL DEFAULT 100,
  idle_timeout TEXT,
  model_id TEXT
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
-- Session Messages
-- =============================================================================
-- Durable, user-facing conversation state. A session is an ordered list of
-- messages. Messages contain typed content blocks: text blocks and assistant
-- tool_call blocks. Tool results are attached to their tool_call block so UI
-- clients render tool output without reconstructing relationships from runtime
-- events. session_events stores replayable deltas over these messages; applying
-- those deltas from an empty list must reconstruct this table exactly.
CREATE TABLE session_messages (
  session_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  workspace_id TEXT,
  id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'streaming', 'complete', 'error')),
  content_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, sequence),
  UNIQUE(session_id, id),
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
) STRICT;

CREATE INDEX idx_session_messages_session_sequence ON session_messages(session_id, sequence);
CREATE INDEX idx_session_messages_session_id ON session_messages(session_id, id);
CREATE INDEX idx_session_messages_workspace ON session_messages(workspace_id);
CREATE INDEX idx_session_messages_workspace_session ON session_messages(workspace_id, session_id);

-- =============================================================================
-- Session Counters
-- =============================================================================
CREATE TABLE session_counters (
  session_id TEXT PRIMARY KEY,
  workspace_id TEXT,
  next_queue_sequence INTEGER NOT NULL DEFAULT 1,
  next_event_sequence INTEGER NOT NULL DEFAULT 1,
  next_message_sequence INTEGER NOT NULL DEFAULT 1,
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
-- Session Tools
-- =============================================================================
CREATE TABLE session_tools (
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

CREATE INDEX idx_session_tools_session_enabled
  ON session_tools(session_id, enabled);

-- =============================================================================
-- Session Runtime State
-- =============================================================================
CREATE TABLE session_runtime (
  session_id TEXT PRIMARY KEY,
  workspace_id TEXT,
  active INTEGER NOT NULL DEFAULT 0,
  workflow_session_json TEXT,
  snapshot_json TEXT,
  workflow_waiting_at INTEGER,
  hot_context_json TEXT,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
) STRICT;

CREATE INDEX idx_session_runtime_active ON session_runtime(active);
CREATE INDEX idx_session_runtime_workspace ON session_runtime(workspace_id);

-- =============================================================================
-- Session Runs
-- =============================================================================
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
) STRICT;

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
) STRICT;

-- =============================================================================
-- Containers
-- =============================================================================
CREATE TABLE containers (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'destroyed')),
  description TEXT,
  last_activity_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
) STRICT;

CREATE INDEX idx_containers_workspace ON containers(workspace_id, deleted_at, updated_at DESC);
CREATE UNIQUE INDEX idx_containers_workspace_name ON containers(workspace_id, name);
CREATE INDEX idx_containers_status ON containers(status);

CREATE TABLE session_container (
  session_id TEXT NOT NULL,
  container_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'attached' CHECK (role IN ('default', 'attached')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, container_id),
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (container_id) REFERENCES containers(id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
) STRICT;

CREATE INDEX idx_session_container_session ON session_container(workspace_id, session_id);
CREATE INDEX idx_session_container_container ON session_container(workspace_id, container_id);

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
-- Providers
-- =============================================================================
CREATE TABLE providers (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  display_name TEXT,
  provider TEXT NOT NULL,
  secret_refs_json TEXT NOT NULL DEFAULT '{}',
  config_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
) STRICT;

CREATE INDEX idx_providers_workspace
  ON providers(workspace_id, deleted_at, updated_at DESC);
CREATE INDEX idx_providers_provider
  ON providers(provider);

-- =============================================================================
-- Models
-- =============================================================================
CREATE TABLE models (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  display_name TEXT,
  model_name TEXT NOT NULL,
  config_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE CASCADE
) STRICT;

CREATE INDEX idx_models_workspace
  ON models(workspace_id, deleted_at, updated_at DESC);
CREATE INDEX idx_models_provider
  ON models(provider_id, model_name);

-- =============================================================================
-- Encrypted Secrets
-- =============================================================================
CREATE TABLE encrypted_secrets (
  workspace_id TEXT NOT NULL,
  key TEXT NOT NULL,
  v INTEGER NOT NULL,
  edek TEXT NOT NULL,
  ct TEXT NOT NULL,
  nonce TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, key)
) STRICT;

CREATE INDEX idx_encrypted_secrets_workspace
  ON encrypted_secrets(workspace_id, updated_at DESC);
