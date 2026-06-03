import { and, eq } from "drizzle-orm";
import { createDb, type Db } from "./db.js";
import { sessionTools } from "./schema.js";

export type SessionToolRefType = "builtin" | "custom";

export interface SessionToolRef {
  sessionId: string;
  toolRefType: SessionToolRefType;
  toolRef: string;
  enabled: boolean;
  config: Record<string, unknown>;
  pinnedVersionId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface UpsertSessionToolRefParams {
  sessionId: string;
  toolRefType: SessionToolRefType;
  toolRef: string;
  enabled?: boolean;
  config?: Record<string, unknown>;
  pinnedVersionId?: string;
}

function mapSessionTool(row: typeof sessionTools.$inferSelect): SessionToolRef {
  return {
    sessionId: row.sessionId,
    toolRefType: row.toolRefType as SessionToolRefType,
    toolRef: row.toolRef,
    enabled: Boolean(row.enabled),
    config: JSON.parse(row.configJson) as Record<string, unknown>,
    pinnedVersionId: row.pinnedVersionId ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class SessionToolRepository {
  private readonly db: Db;

  constructor(db: Db | D1Database) {
    this.db = "query" in db ? db : createDb(db);
  }

  async list(sessionId: string, options: { enabledOnly?: boolean } = {}): Promise<SessionToolRef[]> {
    const where = options.enabledOnly
      ? and(eq(sessionTools.sessionId, sessionId), eq(sessionTools.enabled, 1))
      : eq(sessionTools.sessionId, sessionId);

    const rows = await this.db.query.sessionTools.findMany({ where });
    return rows.map(mapSessionTool);
  }

  async upsert(params: UpsertSessionToolRefParams): Promise<void> {
    const now = Date.now();
    await this.db
      .insert(sessionTools)
      .values({
        sessionId: params.sessionId,
        toolRefType: params.toolRefType,
        toolRef: params.toolRef,
        enabled: params.enabled === false ? 0 : 1,
        configJson: JSON.stringify(params.config ?? {}),
        pinnedVersionId: params.pinnedVersionId ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [sessionTools.sessionId, sessionTools.toolRefType, sessionTools.toolRef],
        set: {
          enabled: params.enabled === false ? 0 : 1,
          configJson: JSON.stringify(params.config ?? {}),
          pinnedVersionId: params.pinnedVersionId ?? null,
          updatedAt: now,
        },
      });
  }

  async seedDefaults(sessionId: string, toolRefs: string[]): Promise<void> {
    await Promise.all(
      toolRefs.map((toolRef) =>
        this.upsert({
          sessionId,
          toolRefType: "builtin",
          toolRef,
        })
      )
    );
  }
}
