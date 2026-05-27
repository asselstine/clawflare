-- Migration: Create encrypted_secrets table for envelope-encrypted secrets
-- Uses composite primary key (workspace_id, key) for efficient lookups

CREATE TABLE IF NOT EXISTS encrypted_secrets (
    workspace_id TEXT NOT NULL,
    key TEXT NOT NULL,
    v INTEGER NOT NULL,                        -- Version for forward compatibility
    edek TEXT NOT NULL,                        -- Encrypted Data Encryption Key (base64)
    ct TEXT NOT NULL,                          -- Ciphertext (base64)
    nonce TEXT NOT NULL,                       -- AES-GCM nonce (base64)
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, key)
);

-- Index for listing all secrets in a workspace (if needed later)
CREATE INDEX IF NOT EXISTS idx_encrypted_secrets_workspace 
    ON encrypted_secrets(workspace_id, updated_at DESC);
