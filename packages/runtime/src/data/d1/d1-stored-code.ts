// D1 Stored Code Repository Implementation
import type {
  StoredCodeRepository,
  StoredCodeEntry,
  UpsertStoredCodeParams,
} from "../interfaces.js";
import type { StoredCodeRow } from "./row-mappers.js";
import { mapStoredCodeRow } from "./row-mappers.js";

export class D1StoredCodeRepository implements StoredCodeRepository {
  constructor(private readonly db: D1Database) {}

  async upsert(entry: UpsertStoredCodeParams): Promise<void> {
    const now = Date.now();

    await this.db
      .prepare(
        `
        INSERT INTO stored_code (
          name, code, description, tags_json, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET
          code = excluded.code,
          description = excluded.description,
          tags_json = excluded.tags_json,
          updated_at = excluded.updated_at
      `
      )
      .bind(
        entry.name,
        entry.code,
        entry.description ?? "",
        JSON.stringify(entry.tags ?? []),
        now,
        now
      )
      .run();
  }

  async get(name: string): Promise<StoredCodeEntry | null> {
    const row = await this.db
      .prepare(
        `
        SELECT name, code, description, tags_json, created_at, updated_at
        FROM stored_code
        WHERE name = ?
      `
      )
      .bind(name)
      .first<StoredCodeRow>();

    return row ? mapStoredCodeRow(row) : null;
  }

  async list(limit = 100): Promise<StoredCodeEntry[]> {
    const result = await this.db
      .prepare(
        `
        SELECT name, code, description, tags_json, created_at, updated_at
        FROM stored_code
        ORDER BY updated_at DESC
        LIMIT ?
      `
      )
      .bind(limit)
      .all<StoredCodeRow>();

    return result.results.map(mapStoredCodeRow);
  }

  async search(query: string, limit = 20): Promise<StoredCodeEntry[]> {
    const q = query === "*" ? "%" : `%${query}%`;

    const result = await this.db
      .prepare(
        `
        SELECT name, code, description, tags_json, created_at, updated_at
        FROM stored_code
        WHERE name LIKE ? OR description LIKE ? OR code LIKE ?
        ORDER BY updated_at DESC
        LIMIT ?
      `
      )
      .bind(q, q, q, limit)
      .all<StoredCodeRow>();

    return result.results.map(mapStoredCodeRow);
  }
}
