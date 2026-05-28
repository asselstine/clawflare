/**
 * Stored Code Data Types
 * 
 * Domain types for stored code management.
 */

/**
 * Stored code entry - workspace scoped
 */
export interface StoredCodeEntry {
  workspaceId: string;
  name: string;
  code: string;
  description?: string;
  tags?: string[];
  createdAt: number;
  updatedAt: number;
}

/**
 * Parameters for upserting stored code
 */
export interface UpsertStoredCodeParams {
  workspaceId: string;
  name: string;
  code: string;
  description?: string;
  tags?: string[];
}

/**
 * Stored code repository - manages reusable code, workspace scoped
 */
export interface StoredCodeRepository {
  /** Upsert a code entry in a workspace */
  upsert(params: UpsertStoredCodeParams): Promise<void>;

  /** Get code by name within a workspace */
  get(workspaceId: string, name: string): Promise<StoredCodeEntry | null>;

  /** List stored code entries in a workspace */
  list(workspaceId: string, limit?: number): Promise<StoredCodeEntry[]>;

  /** Search stored code within a workspace */
  search(workspaceId: string, query: string, limit: number): Promise<StoredCodeEntry[]>;
}
