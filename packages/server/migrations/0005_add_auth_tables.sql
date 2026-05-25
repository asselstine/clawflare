-- Migration 0005: Add authentication tables for Phase 7
-- CLI token and OAuth device authorization tables

PRAGMA foreign_keys = ON;

-- =============================================================================
-- CLI Device Authorizations Table
-- Stores temporary device codes for CLI login flow polling
-- Default expires_at is 10 minutes from creation
-- =============================================================================

CREATE TABLE cli_device_authorizations (
  device_code TEXT PRIMARY KEY,
  user_id TEXT,
  cli_token TEXT,
  completed_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
  expires_at INTEGER DEFAULT (strftime('%s', 'now') * 1000 + 600000),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) STRICT;

CREATE INDEX idx_cli_device_user ON cli_device_authorizations(user_id);
CREATE INDEX idx_cli_device_expires ON cli_device_authorizations(expires_at);

-- =============================================================================
-- Migration complete - auth tables ready for Phase 7
-- =============================================================================
