-- Migration 0001: Initial D1 Data Layer Schema
-- Creates tables for sessions, events, queues, stored code, and egress handlers

PRAGMA foreign_keys = ON;

-- =============================================================================
-- Sessions Table
-- =============================================================================

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('idle', 'processing', 'awaiting_input', 'error', 'closed', 'expired')
  ),
  next_event_cursor INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  error_message TEXT,
  max_queue_size INTEGER NOT NULL DEFAULT 100,
  idle_timeout TEXT
) STRICT;

-- Indexes for session queries
CREATE INDEX idx_sessions_status_updated ON sessions(status, updated_at DESC);
CREATE INDEX idx_sessions_updated ON sessions(updated_at DESC);
CREATE INDEX idx_sessions_workflow ON sessions(workflow_id);

-- =============================================================================
-- Session Events Table
-- =============================================================================

CREATE TABLE session_events (
  session_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  timestamp INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (session_id, sequence),
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
) STRICT;

-- Indexes for event queries
CREATE INDEX idx_session_events_session_sequence ON session_events(session_id, sequence);
CREATE INDEX idx_session_events_type ON session_events(type);
CREATE INDEX idx_session_events_timestamp ON session_events(timestamp);

-- =============================================================================
-- Session Input Queue Table
-- =============================================================================

CREATE TABLE session_input_queue (
  session_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  event_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, sequence),
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
) STRICT;

-- Index for queue operations
CREATE INDEX idx_session_input_queue_session_sequence ON session_input_queue(session_id, sequence);

-- =============================================================================
-- Session Runtime State Table
-- =============================================================================

CREATE TABLE session_runtime (
  session_id TEXT PRIMARY KEY,
  active INTEGER NOT NULL DEFAULT 0,
  workflow_session_json TEXT,
  snapshot_json TEXT,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
) STRICT;

-- Index for active session queries
CREATE INDEX idx_session_runtime_active ON session_runtime(active);

-- =============================================================================
-- Stored Code Table
-- =============================================================================

CREATE TABLE stored_code (
  name TEXT PRIMARY KEY,
  description TEXT,
  code TEXT NOT NULL,
  tags_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

-- Indexes for stored code queries
CREATE INDEX idx_stored_code_updated ON stored_code(updated_at DESC);
CREATE INDEX idx_stored_code_name ON stored_code(name);

-- =============================================================================
-- Egress Handlers Table
-- =============================================================================

CREATE TABLE egress_handlers (
  name TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  domains_json TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  config_json TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL
) STRICT;

-- Indexes for egress handler queries
CREATE INDEX idx_egress_handlers_enabled ON egress_handlers(enabled);
CREATE INDEX idx_egress_handlers_name ON egress_handlers(name);
CREATE INDEX idx_egress_handlers_updated ON egress_handlers(updated_at DESC);

-- =============================================================================
-- Migration metadata
-- =============================================================================

-- Track applied migrations
CREATE TABLE IF NOT EXISTS _d1_migrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  applied_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
) STRICT;

-- Record this migration
INSERT INTO _d1_migrations (name, applied_at) VALUES 
  ('0001_initial_data_layer.sql', unixepoch() * 1000);
