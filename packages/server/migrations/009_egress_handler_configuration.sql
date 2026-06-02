-- Workspace-scoped configurable egress handlers with encrypted secret references.

PRAGMA foreign_keys = OFF;

CREATE TABLE egress_handlers_new (
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

INSERT OR REPLACE INTO egress_handlers_new (
  workspace_id,
  egress_handler_id,
  name,
  description,
  domains_json,
  enabled,
  secret_refs_json,
  config_json,
  updated_at
)
SELECT
  COALESCE(workspace_id, 'default-workspace'),
  name,
  CASE name
    WHEN 'github' THEN 'GitHub'
    WHEN 'cloudflare' THEN 'Cloudflare'
    ELSE name
  END,
  description,
  domains_json,
  enabled,
  '{}',
  config_json,
  updated_at
FROM egress_handlers;

DROP TABLE egress_handlers;
ALTER TABLE egress_handlers_new RENAME TO egress_handlers;

CREATE INDEX idx_egress_handlers_enabled ON egress_handlers(enabled);
CREATE INDEX idx_egress_handlers_id ON egress_handlers(egress_handler_id);
CREATE INDEX idx_egress_handlers_name ON egress_handlers(name);
CREATE INDEX idx_egress_handlers_updated ON egress_handlers(updated_at DESC);
CREATE INDEX idx_egress_handlers_workspace ON egress_handlers(workspace_id);
CREATE INDEX idx_egress_handlers_workspace_enabled ON egress_handlers(workspace_id, enabled);

PRAGMA foreign_keys = ON;
