// D1 Egress Handlers Repository Implementation
import type {
  EgressHandlerRepository,
  EgressHandlerMetadata,
  UpsertEgressHandlerParams,
} from "../interfaces.js";
import type { EgressHandlerRow } from "./row-mappers.js";
import { mapEgressHandlerRow } from "./row-mappers.js";
import { metadata as githubMetadata } from "@clawflare/github";
import { metadata as cloudflareMetadata } from "@clawflare/cloudflare";

const BUILT_IN_EGRESS_HANDLERS: EgressHandlerMetadata[] = [
  {
    name: githubMetadata.name,
    description: githubMetadata.description,
    domains: githubMetadata.domains,
    enabled: true,
    config: {},
    updatedAt: 0,
  },
  {
    name: cloudflareMetadata.name,
    description: cloudflareMetadata.description,
    domains: cloudflareMetadata.domains,
    enabled: true,
    config: {},
    updatedAt: 0,
  },
];

function mergeBuiltIns(rows: EgressHandlerMetadata[]): EgressHandlerMetadata[] {
  const byName = new Map<string, EgressHandlerMetadata>();
  for (const handler of BUILT_IN_EGRESS_HANDLERS) byName.set(handler.name, handler);
  for (const handler of rows) byName.set(handler.name, handler);
  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function matchesQuery(handler: EgressHandlerMetadata, query: string): boolean {
  if (query === "*" || query === "") return true;
  const normalized = query.replace(/^\*/, "").toLowerCase();
  return handler.name.toLowerCase().includes(normalized)
    || handler.description.toLowerCase().includes(normalized)
    || handler.domains.some((domain) => domain.toLowerCase().includes(normalized));
}

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
    const rows = result.results.map(mapEgressHandlerRow);
    const merged = mergeBuiltIns(rows);
    return enabledOnly ? merged.filter((handler) => handler.enabled) : merged;
  }

  async search(query: string, limit = 20): Promise<EgressHandlerMetadata[]> {
    const q = query === "*" ? "%" : `%${query}%`;

    const result = await this.db
      .prepare(
        `
        SELECT name, description, domains_json, enabled, config_json, updated_at
        FROM egress_handlers
        WHERE name LIKE ?
           OR description LIKE ?
           OR domains_json LIKE ?
        ORDER BY name ASC
        LIMIT ?
      `
      )
      .bind(q, q, q, limit)
      .all<EgressHandlerRow>();

    const dbResults = result.results.map(mapEgressHandlerRow);
    const merged = mergeBuiltIns(dbResults).filter((handler) => matchesQuery(handler, query));
    return merged.slice(0, limit);
  }
}
