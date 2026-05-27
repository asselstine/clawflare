/**
 * Encrypted Secret Repository
 * Stores envelope-encrypted secrets in D1
 */

import type { EncryptedSecretEnvelope } from "./crypto.js";

export interface EncryptedSecretRecord {
  workspaceId: string;
  /** Format: model-connections/{connectionId}/{secretKey} or other key types */
  key: string;
  /** Version for forward compatibility */
  v: number;
  /** Base64-encoded encrypted DEK */
  edek: string;
  /** Base64-encoded encrypted secret ciphertext */
  ct: string;
  /** Base64-encoded AES-GCM nonce */
  nonce: string;
  createdAt: number;
  updatedAt: number;
}

export interface SecretRepository {
  get(workspaceId: string, key: string): Promise<EncryptedSecretRecord | null>;
  put(workspaceId: string, key: string, envelope: EncryptedSecretEnvelope): Promise<void>;
  delete(workspaceId: string, key: string): Promise<void>;
}

/**
 * Create the database key for a model connection secret
 */
export function createKey(
  connectionId: string,
  secretKey: string
): string {
  return `model-connections/${connectionId}/${secretKey}`;
}

/**
 * D1-based secret repository implementation
 */
export class D1SecretRepository implements SecretRepository {
  constructor(private readonly db: D1Database) {}


  async get(workspaceId: string, key: string): Promise<EncryptedSecretRecord | null> {
    const result = await this.db
      .prepare(
        `SELECT * FROM encrypted_secrets 
         WHERE workspace_id = ? AND key = ?`
      )
      .bind(workspaceId, key)
      .first<{
        workspace_id: string;
        key: string;
        v: number;
        edek: string;
        ct: string;
        nonce: string;
        created_at: number;
        updated_at: number;
      }>();

    if (!result) return null;

    return {
      workspaceId: result.workspace_id,
      key: result.key,
      v: result.v,
      edek: result.edek,
      ct: result.ct,
      nonce: result.nonce,
      createdAt: result.created_at,
      updatedAt: result.updated_at,
    };
  }

  async put(
    workspaceId: string,
    key: string,
    envelope: EncryptedSecretEnvelope
  ): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO encrypted_secrets 
         (workspace_id, key, v, edek, ct, nonce, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(workspace_id, key) DO UPDATE SET
           v = excluded.v,
           edek = excluded.edek,
           ct = excluded.ct,
           nonce = excluded.nonce,
           updated_at = excluded.updated_at`
      )
      .bind(
        workspaceId,
        key,
        envelope.v,
        envelope.edek,
        envelope.ct,
        envelope.nonce,
        envelope.createdAt,
        Date.now()
      )
      .run();
  }

  async delete(workspaceId: string, key: string): Promise<void> {
    await this.db
      .prepare(
        `DELETE FROM encrypted_secrets 
         WHERE workspace_id = ? AND key = ?`
      )
      .bind(workspaceId, key)
      .run();
  }
}

/**
 * Get or create the secret repository for this database
 */
export function getSecretRepository(db: D1Database): SecretRepository {
  return new D1SecretRepository(db);
}
