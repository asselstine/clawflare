-- Migration 0006: Complete Auth Schema
-- Native email/password auth with device authorization flow

PRAGMA foreign_keys = ON;

-- =============================================================================
-- Password Credentials Table
-- Stores hashed passwords for native email/password auth
-- =============================================================================

CREATE TABLE password_credentials (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  password_hash TEXT NOT NULL,
  password_updated_at INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_password_credentials_updated ON password_credentials(password_updated_at);

-- =============================================================================
-- Web Sessions Table
-- For browser-based authenticated sessions (HTTP-only cookie)
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
-- Access Tokens Table
-- For programmatic client access (CLI, API clients, etc.)
-- Replaces the old cli_tokens table
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
-- Device Authorizations Table
-- For device authorization flow (CLI, mobile apps, etc.)
-- Replaces the old cli_device_authorizations table
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
  created_at INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_device_authorizations_user_code ON device_authorizations(user_code);
CREATE INDEX idx_device_authorizations_user_id ON device_authorizations(user_id);
CREATE INDEX idx_device_authorizations_expires_at ON device_authorizations(expires_at);
CREATE INDEX idx_device_authorizations_status ON device_authorizations(status);

-- =============================================================================
-- Email Verification Tokens Table
-- For email verification flow
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
-- Password Reset Tokens Table
-- For password reset flow
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
-- Migration complete - complete auth schema ready
-- =============================================================================
