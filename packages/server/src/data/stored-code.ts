/**
 * Stored Code Data Types
 * 
 * Domain types for stored code management.
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

export interface UpsertStoredCodeParams {
  workspaceId: string;
  name: string;
  code: string;
  description?: string;
  tags?: string[];
}

// Stored Code Repository Implementation
// Workspace-scoped for multi-tenant data access

import { createDb, type Db } from "./db.js";
import { storedCode } from "./schema.js";
import { and, desc, eq, like, or } from "drizzle-orm";

function mapStoredCode(row: typeof storedCode.$inferSelect): StoredCodeEntry {
  return {
    workspaceId: row.workspaceId,
    name: row.name,
    code: row.code,
    description: row.description ?? undefined,
    tags: JSON.parse(row.tagsJson) as string[],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class StoredCodeRepository {
  private readonly db: Db;

  constructor(db: Db | D1Database) {
    this.db = "query" in db ? db : createDb(db);
  }

  async upsert(params: UpsertStoredCodeParams): Promise<void> {
    const now = Date.now();

    await this.db
      .insert(storedCode)
      .values({
        workspaceId: params.workspaceId,
        name: params.name,
        code: params.code,
        description: params.description ?? "",
        tagsJson: JSON.stringify(params.tags ?? []),
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [storedCode.workspaceId, storedCode.name],
        set: {
          code: params.code,
          description: params.description ?? "",
          tagsJson: JSON.stringify(params.tags ?? []),
          updatedAt: now,
        },
      });
  }

  async get(workspaceId: string, name: string): Promise<StoredCodeEntry | null> {
    const row = await this.db.query.storedCode.findFirst({
      where: and(eq(storedCode.workspaceId, workspaceId), eq(storedCode.name, name)),
    });

    return row ? mapStoredCode(row) : null;
  }

  async list(workspaceId: string, limit = 100): Promise<StoredCodeEntry[]> {
    const rows = await this.db.query.storedCode.findMany({
      where: eq(storedCode.workspaceId, workspaceId),
      orderBy: [desc(storedCode.updatedAt)],
      limit,
    });

    return rows.map(mapStoredCode);
  }

  async search(workspaceId: string, query: string, limit = 20): Promise<StoredCodeEntry[]> {
    const q = query === "*" ? "%" : `%${query}%`;

    const rows = await this.db.query.storedCode.findMany({
      where: and(
        eq(storedCode.workspaceId, workspaceId),
        or(
          like(storedCode.name, q),
          like(storedCode.description, q),
          like(storedCode.code, q)
        )
      ),
      orderBy: [desc(storedCode.updatedAt)],
      limit,
    });

    return rows.map(mapStoredCode);
  }
}
