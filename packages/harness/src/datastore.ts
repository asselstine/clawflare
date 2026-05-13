// Clawflare Datastore - SQLite-backed Durable Object
// Stores code, egress handlers, and other indexed data

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./types";

export interface StoredCode {
  name: string;
  description: string;
  code: string;
  createdAt: number;
  updatedAt: number;
}

export interface EgressHandlerMetadata {
  name: string;
  packageName: string;
  description: string;
  enabled: boolean;
  domains: string[];
  config?: unknown;
  createdAt: number;
  updatedAt: number;
}

export class ClawflareDatastore extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState<Env>, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.initSchema();
    this.seedDefaultEgressHandlers();
  }

  private initSchema(): void {
    // Stored code table
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS stored_code (
        name TEXT PRIMARY KEY,
        description TEXT,
        code TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    // Egress handlers table
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS egress_handlers (
        name TEXT PRIMARY KEY,
        package_name TEXT NOT NULL,
        description TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        domains_json TEXT NOT NULL,
        config_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
  }

  private seedDefaultEgressHandlers(): void {
    const now = Date.now();
    const defaults = [
      {
        name: "github",
        packageName: "@clawflare/github",
        description: "GitHub API and content access",
        domains: ["api.github.com", "github.com", "raw.githubusercontent.com"],
      },
      {
        name: "cloudflare",
        packageName: "@clawflare/cloudflare",
        description: "Cloudflare REST API access",
        domains: ["api.cloudflare.com"],
      },
    ];

    for (const handler of defaults) {
      const existing = firstRow(this.sql.exec(
        "SELECT name FROM egress_handlers WHERE name = ?",
        handler.name
      ));
      if (existing) continue;

      this.sql.exec(
        `INSERT INTO egress_handlers
         (name, package_name, description, enabled, domains_json, config_json, created_at, updated_at)
         VALUES (?, ?, ?, 1, ?, NULL, ?, ?)`,
        handler.name,
        handler.packageName,
        handler.description,
        JSON.stringify(handler.domains),
        now,
        now
      );
    }
  }

  // Stored Code Operations
  async upsertStoredCode(code: Omit<StoredCode, "createdAt" | "updatedAt">): Promise<StoredCode> {
    const now = Date.now();
    const existing = firstRow(this.sql.exec(
      "SELECT created_at FROM stored_code WHERE name = ?",
      code.name
    ));

    const createdAt = existing ? Number(existing.created_at) : now;

    this.sql.exec(
      `INSERT OR REPLACE INTO stored_code (name, description, code, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      code.name,
      code.description || "",
      code.code,
      createdAt,
      now
    );

    return {
      ...code,
      createdAt,
      updatedAt: now,
    };
  }

  async getStoredCode(name: string): Promise<StoredCode | null> {
    const row = firstRow(this.sql.exec(
      "SELECT name, description, code, created_at, updated_at FROM stored_code WHERE name = ?",
      name
    ));

    if (!row) return null;

    return {
      name: String(row.name),
      description: String(row.description),
      code: String(row.code),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  async searchStoredCode(query?: string, limit = 20): Promise<Array<Omit<StoredCode, "code">>> {
    let rows;

    if (query) {
      const pattern = `%${query}%`;
      rows = this.sql.exec(
        `SELECT name, description, created_at, updated_at 
         FROM stored_code 
         WHERE name LIKE ? OR description LIKE ?
         ORDER BY updated_at DESC
         LIMIT ?`,
        pattern,
        pattern,
        limit
      );
    } else {
      rows = this.sql.exec(
        `SELECT name, description, created_at, updated_at 
         FROM stored_code 
         ORDER BY updated_at DESC
         LIMIT ?`,
        limit
      );
    }

    return Array.from(rows).map((row: unknown) => ({
      name: String((row as { name: unknown }).name),
      description: String((row as { description: unknown }).description),
      code: "", // Not returned in search to save tokens
      createdAt: Number((row as { created_at: unknown }).created_at),
      updatedAt: Number((row as { updated_at: unknown }).updated_at),
    }));
  }

  // Egress Handler Operations
  async upsertEgressHandler(handler: Omit<EgressHandlerMetadata, "createdAt" | "updatedAt">): Promise<EgressHandlerMetadata> {
    const now = Date.now();
    const existing = firstRow(this.sql.exec(
      "SELECT created_at FROM egress_handlers WHERE name = ?",
      handler.name
    ));

    const createdAt = existing ? Number(existing.created_at) : now;

    this.sql.exec(
      `INSERT OR REPLACE INTO egress_handlers 
       (name, package_name, description, enabled, domains_json, config_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      handler.name,
      handler.packageName,
      handler.description || "",
      handler.enabled ? 1 : 0,
      JSON.stringify(handler.domains),
      handler.config ? JSON.stringify(handler.config) : null,
      createdAt,
      now
    );

    return {
      ...handler,
      createdAt,
      updatedAt: now,
    };
  }

  async getEgressHandler(name: string): Promise<EgressHandlerMetadata | null> {
    const row = firstRow(this.sql.exec(
      "SELECT * FROM egress_handlers WHERE name = ?",
      name
    ));

    if (!row) return null;

    return {
      name: String(row.name),
      packageName: String(row.package_name),
      description: String(row.description),
      enabled: Number(row.enabled) === 1,
      domains: JSON.parse(String(row.domains_json)) as string[],
      config: row.config_json ? JSON.parse(String(row.config_json)) : undefined,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  async listEgressHandlers(enabledOnly = false): Promise<EgressHandlerMetadata[]> {
    let query = "SELECT * FROM egress_handlers";
    if (enabledOnly) {
      query += " WHERE enabled = 1";
    }
    query += " ORDER BY name";

    const rows = this.sql.exec(query);

    return Array.from(rows).map((row: unknown) => ({
      name: String((row as { name: unknown }).name),
      packageName: String((row as { package_name: unknown }).package_name),
      description: String((row as { description: unknown }).description),
      enabled: Number((row as { enabled: unknown }).enabled) === 1,
      domains: JSON.parse(String((row as { domains_json: unknown }).domains_json)) as string[],
      config: (row as { config_json: unknown }).config_json ? JSON.parse(String((row as { config_json: unknown }).config_json)) : undefined,
      createdAt: Number((row as { created_at: unknown }).created_at),
      updatedAt: Number((row as { updated_at: unknown }).updated_at),
    }));
  }

  async searchEgressHandlers(query?: string, limit = 20): Promise<EgressHandlerMetadata[]> {
    let rows;

    if (query) {
      const pattern = `%${query}%`;
      rows = this.sql.exec(
        `SELECT * FROM egress_handlers 
         WHERE name LIKE ? OR description LIKE ? OR domains_json LIKE ?
         ORDER BY name
         LIMIT ?`,
        pattern,
        pattern,
        pattern,
        limit
      );
    } else {
      rows = this.sql.exec(
        `SELECT * FROM egress_handlers ORDER BY name LIMIT ?`,
        limit
      );
    }

    return Array.from(rows).map((row: unknown) => ({
      name: String((row as { name: unknown }).name),
      packageName: String((row as { package_name: unknown }).package_name),
      description: String((row as { description: unknown }).description),
      enabled: Number((row as { enabled: unknown }).enabled) === 1,
      domains: JSON.parse(String((row as { domains_json: unknown }).domains_json)) as string[],
      config: (row as { config_json: unknown }).config_json ? JSON.parse(String((row as { config_json: unknown }).config_json)) : undefined,
      createdAt: Number((row as { created_at: unknown }).created_at),
      updatedAt: Number((row as { updated_at: unknown }).updated_at),
    }));
  }

  // Generic search across collections
  async search(
    collection: "stored_code" | "egress_handlers" | "all",
    query?: string,
    limit = 20
  ): Promise<{
    storedCode: Array<Omit<StoredCode, "code">>;
    egressHandlers: EgressHandlerMetadata[];
  }> {
    const result = {
      storedCode: [] as Array<Omit<StoredCode, "code">>,
      egressHandlers: [] as EgressHandlerMetadata[],
    };

    if (collection === "stored_code" || collection === "all") {
      result.storedCode = await this.searchStoredCode(query, limit);
    }

    if (collection === "egress_handlers" || collection === "all") {
      result.egressHandlers = await this.searchEgressHandlers(query, limit);
    }

    return result;
  }
}

function firstRow(rows: Iterable<unknown>): Record<string, unknown> | null {
  const iterator = rows[Symbol.iterator]();
  const next = iterator.next();
  return next.done ? null : (next.value as Record<string, unknown>);
}

// Helper to get datastore instance
export function getDatastore(env: { DATASTORE: DurableObjectNamespace }): ClawflareDatastore {
  const id = env.DATASTORE.idFromName("global");
  return env.DATASTORE.get(id) as unknown as ClawflareDatastore;
}
