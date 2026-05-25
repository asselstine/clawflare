-- Migration 0008: Add OAuth state fields for device authorization
-- Supports secure GitHub OAuth flow for CLI login

PRAGMA foreign_keys = ON;

-- =============================================================================
-- Add OAuth state tracking to device_authorizations
-- This enables secure CLI login via GitHub OAuth
-- =============================================================================

ALTER TABLE device_authorizations ADD COLUMN oauth_state_hash TEXT;
ALTER TABLE device_authorizations ADD COLUMN access_token_plaintext TEXT;
ALTER TABLE device_authorizations ADD COLUMN token_retrieved_at INTEGER;

-- Index for OAuth state lookups
CREATE INDEX IF NOT EXISTS idx_device_authorizations_oauth_state_hash
  ON device_authorizations(oauth_state_hash);

-- =============================================================================
-- Migration complete - device auth OAuth fields ready
-- =============================================================================
