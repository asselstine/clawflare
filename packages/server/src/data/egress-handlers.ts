/**
 * Egress Handler Data Types
 * 
 * Domain types for egress handler management.
 */


export interface EgressHandlerMetadata {
  workspaceId: string;
  egressHandlerId: string;
  name: string;
  description: string;
  domains: string[];
  enabled: boolean;
  secretRefs: Record<string, string>;
  config: unknown;
  updatedAt: number;
}

export interface UpsertEgressHandlerParams {
  workspaceId: string;
  egressHandlerId: string;
  name: string;
  description: string;
  domains: string[];
  enabled?: boolean;
  secretRefs?: Record<string, string>;
  config?: unknown;
}

// Egress Handlers Repository Implementation
// Workspace-scoped for multi-tenant data access

import { createDb, type Db } from "./db.js";
import { egressHandlers } from "./schema.js";
import { metadata as githubMetadata } from "@clawflare/github";
import { metadata as cloudflareMetadata } from "@clawflare/cloudflare";
import { and, asc, eq, like, or } from "drizzle-orm";

const BUILT_IN_EGRESS_HANDLERS: Omit<EgressHandlerMetadata, "workspaceId">[] = [
  {
    egressHandlerId: githubMetadata.name,
    name: "GitHub",
    description: githubMetadata.description,
    domains: githubMetadata.domains,
    enabled: false,
    secretRefs: {},
    config: {},
    updatedAt: 0,
  },
  {
    egressHandlerId: cloudflareMetadata.name,
    name: "Cloudflare",
    description: cloudflareMetadata.description,
    domains: cloudflareMetadata.domains,
    enabled: false,
    secretRefs: {},
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
  const byId = new Map<string, EgressHandlerMetadata>();
  
  // Add built-ins first (they'll be overridden by DB entries if same name exists)
  for (const handler of BUILT_IN_EGRESS_HANDLERS) {
    byId.set(handler.egressHandlerId, { ...handler, workspaceId });
  }
  
  // Override with DB entries
  for (const handler of rows) {
    byId.set(handler.egressHandlerId, handler);
  }
  
  return Array.from(byId.values()).sort((a, b) => a.egressHandlerId.localeCompare(b.egressHandlerId));
}

function matchesQuery(handler: EgressHandlerMetadata, query: string): boolean {
  if (query === "*" || query === "") return true;
  const normalized = query.replace(/^\*+|\*+$/g, "").toLowerCase();
  return handler.name.toLowerCase().includes(normalized)
    || handler.egressHandlerId.toLowerCase().includes(normalized)
    || handler.description.toLowerCase().includes(normalized)
    || handler.domains.some((domain) => domain.toLowerCase().includes(normalized));
}

function normalizeSearchQuery(query: string): string {
  return query.replace(/^\*+|\*+$/g, "");
}

function mapEgressHandler(row: typeof egressHandlers.$inferSelect): EgressHandlerMetadata {
  return {
    workspaceId: row.workspaceId ?? "",
    egressHandlerId: row.egressHandlerId,
    name: row.name,
    description: row.description,
    domains: JSON.parse(row.domainsJson) as string[],
    enabled: Boolean(row.enabled),
    secretRefs: JSON.parse(row.secretRefsJson) as Record<string, string>,
    config: JSON.parse(row.configJson) as unknown,
    updatedAt: row.updatedAt,
  };
}

export class EgressHandlerRepository {
  private readonly db: Db;

  constructor(db: Db | D1Database) {
    this.db = "query" in db ? db : createDb(db);
  }

  async upsert(params: UpsertEgressHandlerParams): Promise<void> {
    const now = Date.now();
    const domainsJson = JSON.stringify(params.domains);
    const secretRefsJson = JSON.stringify(params.secretRefs ?? {});
    const configJson = JSON.stringify(params.config ?? {});

    await this.db
      .insert(egressHandlers)
      .values({
        workspaceId: params.workspaceId,
        egressHandlerId: params.egressHandlerId,
        name: params.name,
        description: params.description,
        domainsJson,
        enabled: params.enabled === false ? 0 : 1,
        secretRefsJson,
        configJson,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [egressHandlers.workspaceId, egressHandlers.egressHandlerId],
        set: {
          name: params.name,
          description: params.description,
          domainsJson,
          enabled: params.enabled === false ? 0 : 1,
          secretRefsJson,
          configJson,
          updatedAt: now,
        },
      });
  }

  async get(workspaceId: string, egressHandlerId: string): Promise<EgressHandlerMetadata | null> {
    // First check built-ins
    const builtIn = BUILT_IN_EGRESS_HANDLERS.find((h) => h.egressHandlerId === egressHandlerId);
    
    const row = await this.db.query.egressHandlers.findFirst({
      where: and(eq(egressHandlers.workspaceId, workspaceId), eq(egressHandlers.egressHandlerId, egressHandlerId)),
    });

    if (row) {
      return mapEgressHandler(row);
    }

    // Return built-in as fallback with this workspace context
    if (builtIn) {
      return { ...builtIn, workspaceId };
    }

    return null;
  }

  async getConfigured(workspaceId: string, egressHandlerId: string): Promise<EgressHandlerMetadata | null> {
    const row = await this.db.query.egressHandlers.findFirst({
      where: and(eq(egressHandlers.workspaceId, workspaceId), eq(egressHandlers.egressHandlerId, egressHandlerId)),
    });

    return row ? mapEgressHandler(row) : null;
  }

  async delete(workspaceId: string, egressHandlerId: string): Promise<void> {
    await this.db
      .delete(egressHandlers)
      .where(and(eq(egressHandlers.workspaceId, workspaceId), eq(egressHandlers.egressHandlerId, egressHandlerId)));
  }

  async list(workspaceId: string, enabledOnly = false): Promise<EgressHandlerMetadata[]> {
    const rows = await this.db.query.egressHandlers.findMany({
      where: enabledOnly
        ? and(eq(egressHandlers.workspaceId, workspaceId), eq(egressHandlers.enabled, 1))
        : eq(egressHandlers.workspaceId, workspaceId),
      orderBy: [asc(egressHandlers.name)],
    });
    const merged = mergeBuiltIns(workspaceId, rows.map(mapEgressHandler));
    return enabledOnly ? merged.filter((handler) => handler.enabled) : merged;
  }

  async search(workspaceId: string, query: string, limit = 20): Promise<EgressHandlerMetadata[]> {
    const normalizedQuery = normalizeSearchQuery(query);
    const q = query === "*" || normalizedQuery === "" ? "%" : `%${normalizedQuery}%`;

    const rows = await this.db.query.egressHandlers.findMany({
      where: and(
        eq(egressHandlers.workspaceId, workspaceId),
        or(
          like(egressHandlers.name, q),
          like(egressHandlers.egressHandlerId, q),
          like(egressHandlers.description, q),
          like(egressHandlers.domainsJson, q)
        )
      ),
      orderBy: [asc(egressHandlers.name)],
      limit,
    });

    const dbResults = rows.map(mapEgressHandler);
    const merged = mergeBuiltIns(workspaceId, dbResults).filter((handler) => matchesQuery(handler, query));
    return merged.slice(0, limit);
  }
}
