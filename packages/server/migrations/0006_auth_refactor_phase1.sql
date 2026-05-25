-- Migration 0006: Auth Refactoring Phase 1
-- Rename CLI-specific auth tables to generic device auth tables

PRAGMA foreign_keys = ON;

-- =============================================================================
-- Access Tokens Table (replaces cli_tokens)
-- Stores hashed access tokens for API authentication
-- =============================================================================

CREATE TABLE access_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  client_name TEXT,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  expires_at INTEGER,
  revoked_at INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) STRICT;

CREATE INDEX idx_access_tokens_user_id ON access_tokens(user_id);
CREATE INDEX idx_access_tokens_token_hash ON access_tokens(token_hash);

-- =============================================================================
-- Device Authorizations Table (replaces cli_device_authorizations)
-- Stores temporary device codes for device authorization flow polling
-- Default expires_at is 10 minutes from creation
-- =============================================================================

CREATE TABLE device_authorizations (
  device_code TEXT PRIMARY KEY,
  client_name TEXT NOT NULL,
  user_id TEXT,
  access_token_id TEXT,
  access_token_plaintext TEXT,
  completed_at INTEGER,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_device_authorizations_user_id ON device_authorizations(user_id);
CREATE INDEX idx_device_authorizations_expires_at ON device_authorizations(expires_at);

-- =============================================================================
-- Migration complete - auth tables ready for generic device authorization
-- =============================================================================
