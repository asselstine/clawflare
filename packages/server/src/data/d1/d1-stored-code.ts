// D1 Stored Code Repository Implementation
// Workspace-scoped for multi-tenant data access

import type {
  StoredCodeRepository,
  StoredCodeEntry,
  UpsertStoredCodeParams,
} from "../interfaces.js";
import type { StoredCodeRow } from "./row-mappers.js";
import { mapStoredCodeRow } from "./row-mappers.js";

export class D1StoredCodeRepository implements StoredCodeRepository {
  constructor(private readonly db: D1Database) {}

  async upsert(params: UpsertStoredCodeParams): Promise<void> {
    const now = Date.now();

    await this.db
      .prepare(
        `
        INSERT INTO stored_code (
          workspace_id, name, code, description, tags_json, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(workspace_id, name) DO UPDATE SET
          code = excluded.code,
          description = excluded.description,
          tags_json = excluded.tags_json,
          updated_at = excluded.updated_at
      `
      )
      .bind(
        params.workspaceId,
        params.name,
        params.code,
        params.description ?? "",
        JSON.stringify(params.tags ?? []),
        now,
        now
      )
      .run();
  }

  async get(workspaceId: string, name: string): Promise<StoredCodeEntry | null> {
    const row = await this.db
      .prepare(
        `
        SELECT workspace_id, name, code, description, tags_json, created_at, updated_at
        FROM stored_code
        WHERE workspace_id = ? AND name = ?
      `
      )
      .bind(workspaceId, name)
      .first<StoredCodeRow>();

    return row ? mapStoredCodeRow(row) : null;
  }

  async list(workspaceId: string, limit = 100): Promise<StoredCodeEntry[]> {
    const result = await this.db
      .prepare(
        `
        SELECT workspace_id, name, code, description, tags_json, created_at, updated_at
        FROM stored_code
        WHERE workspace_id = ?
        ORDER BY updated_at DESC
        LIMIT ?
      `
      )
      .bind(workspaceId, limit)
      .all<StoredCodeRow>();

    return result.results.map(mapStoredCodeRow);
  }

  async search(workspaceId: string, query: string, limit = 20): Promise<StoredCodeEntry[]> {
    const q = query === "*" ? "%" : `%${query}%`;

    const result = await this.db
      .prepare(
        `
        SELECT workspace_id, name, code, description, tags_json, created_at, updated_at
        FROM stored_code
        WHERE workspace_id = ?
          AND (name LIKE ? OR description LIKE ? OR code LIKE ?)
        ORDER BY updated_at DESC
        LIMIT ?
      `
      )
      .bind(workspaceId, q, q, q, limit)
      .all<StoredCodeRow>();

    return result.results.map(mapStoredCodeRow);
  }
}
