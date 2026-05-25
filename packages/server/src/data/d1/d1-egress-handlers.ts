// D1 Egress Handlers Repository Implementation
// Workspace-scoped for multi-tenant data access

import type {
  EgressHandlerRepository,
  EgressHandlerMetadata,
  UpsertEgressHandlerParams,
} from "../interfaces.js";
import type { EgressHandlerRow } from "./row-mappers.js";
import { mapEgressHandlerRow } from "./row-mappers.js";
import { metadata as githubMetadata } from "@clawflare/github";
import { metadata as cloudflareMetadata } from "@clawflare/cloudflare";

const BUILT_IN_EGRESS_HANDLERS: Omit<EgressHandlerMetadata, "workspaceId">[] = [
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

/**
 * Merge built-in egress handlers with database results.
 * Built-ins are returned for any workspace query since they're global.
 */
function mergeBuiltIns(
  workspaceId: string,
  rows: EgressHandlerMetadata[]
): EgressHandlerMetadata[] {
  const byName = new Map<string, EgressHandlerMetadata>();
  
  // Add built-ins first (they'll be overridden by DB entries if same name exists)
  for (const handler of BUILT_IN_EGRESS_HANDLERS) {
    byName.set(handler.name, { ...handler, workspaceId });
  }
  
  // Override with DB entries
  for (const handler of rows) {
    byName.set(handler.name, handler);
  }
  
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

  async upsert(params: UpsertEgressHandlerParams): Promise<void> {
    const now = Date.now();

    await this.db
      .prepare(
        `
        INSERT INTO egress_handlers (
          workspace_id, name, description, domains_json, enabled, config_json, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(workspace_id, name) DO UPDATE SET
          description = excluded.description,
          domains_json = excluded.domains_json,
          enabled = excluded.enabled,
          config_json = excluded.config_json,
          updated_at = excluded.updated_at
      `
      )
      .bind(
        params.workspaceId,
        params.name,
        params.description,
        JSON.stringify(params.domains),
        params.enabled === false ? 0 : 1,
        JSON.stringify(params.config ?? {}),
        now
      )
      .run();
  }

  async get(workspaceId: string, name: string): Promise<EgressHandlerMetadata | null> {
    // First check built-ins
    const builtIn = BUILT_IN_EGRESS_HANDLERS.find((h) => h.name === name);
    
    const row = await this.db
      .prepare(
        `
        SELECT workspace_id, name, description, domains_json, enabled, config_json, updated_at
        FROM egress_handlers
        WHERE workspace_id = ? AND name = ?
      `
      )
      .bind(workspaceId, name)
      .first<EgressHandlerRow>();

    if (row) {
      return mapEgressHandlerRow(row);
    }

    // Return built-in as fallback with this workspace context
    if (builtIn) {
      return { ...builtIn, workspaceId };
    }

    return null;
  }

  async list(workspaceId: string, enabledOnly = false): Promise<EgressHandlerMetadata[]> {
    const sql = enabledOnly
      ? `
        SELECT workspace_id, name, description, domains_json, enabled, config_json, updated_at
        FROM egress_handlers
        WHERE workspace_id = ? AND enabled = 1
        ORDER BY name ASC
      `
      : `
        SELECT workspace_id, name, description, domains_json, enabled, config_json, updated_at
        FROM egress_handlers
        WHERE workspace_id = ?
        ORDER BY name ASC
      `;

    const result = await this.db.prepare(sql).bind(workspaceId).all<EgressHandlerRow>();
    const rows = result.results.map(mapEgressHandlerRow);
    const merged = mergeBuiltIns(workspaceId, rows);
    return enabledOnly ? merged.filter((handler) => handler.enabled) : merged;
  }

  async search(workspaceId: string, query: string, limit = 20): Promise<EgressHandlerMetadata[]> {
    const q = query === "*" ? "%" : `%${query}%`;

    const result = await this.db
      .prepare(
        `
        SELECT workspace_id, name, description, domains_json, enabled, config_json, updated_at
        FROM egress_handlers
        WHERE workspace_id = ?
          AND (name LIKE ? OR description LIKE ? OR domains_json LIKE ?)
        ORDER BY name ASC
        LIMIT ?
      `
      )
      .bind(workspaceId, q, q, q, limit)
      .all<EgressHandlerRow>();

    const dbResults = result.results.map(mapEgressHandlerRow);
    const merged = mergeBuiltIns(workspaceId, dbResults).filter((handler) => matchesQuery(handler, query));
    return merged.slice(0, limit);
  }
}
