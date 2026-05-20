// D1 Egress Handlers Repository Implementation
import type {
  EgressHandlerRepository,
  EgressHandlerMetadata,
  UpsertEgressHandlerParams,
} from "../interfaces.js";
import type { EgressHandlerRow } from "./row-mappers.js";
import { mapEgressHandlerRow } from "./row-mappers.js";

export class D1EgressHandlerRepository implements EgressHandlerRepository {
  constructor(private readonly db: D1Database) {}

  async upsert(entry: UpsertEgressHandlerParams): Promise<void> {
    const now = Date.now();

    await this.db
      .prepare(
        `
        INSERT INTO egress_handlers (
          name, description, domains_json, enabled, config_json, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET
          description = excluded.description,
          domains_json = excluded.domains_json,
          enabled = excluded.enabled,
          config_json = excluded.config_json,
          updated_at = excluded.updated_at
      `
      )
      .bind(
        entry.name,
        entry.description,
        JSON.stringify(entry.domains),
        entry.enabled === false ? 0 : 1,
        JSON.stringify(entry.config ?? {}),
        now
      )
      .run();
  }

  async get(name: string): Promise<EgressHandlerMetadata | null> {
    const row = await this.db
      .prepare(
        `
        SELECT name, description, domains_json, enabled, config_json, updated_at
        FROM egress_handlers
        WHERE name = ?
      `
      )
      .bind(name)
      .first<EgressHandlerRow>();

    return row ? mapEgressHandlerRow(row) : null;
  }

  async list(enabledOnly = false): Promise<EgressHandlerMetadata[]> {
    const sql = enabledOnly
      ? `
        SELECT name, description, domains_json, enabled, config_json, updated_at
        FROM egress_handlers
        WHERE enabled = 1
        ORDER BY name ASC
      `
      : `
        SELECT name, description, domains_json, enabled, config_json, updated_at
        FROM egress_handlers
        ORDER BY name ASC
      `;

    const result = await this.db.prepare(sql).all<EgressHandlerRow>();
    return result.results.map(mapEgressHandlerRow);
  }

  async search(query: string, limit = 20): Promise<EgressHandlerMetadata[]> {
    const q = query === "*" ? "%" : `%${query}%`;

    const result = await this.db
      .prepare(
        `
        SELECT name, description, domains_json, enabled, config_json, updated_at
        FROM egress_handlers
        WHERE name LIKE ? OR description LIKE ?
        ORDER BY name ASC
        LIMIT ?
      `
      )
      .bind(q, q, limit)
      .all<EgressHandlerRow>();

    return result.results.map(mapEgressHandlerRow);
  }
}
