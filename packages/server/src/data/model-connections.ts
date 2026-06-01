/**
 * Model Connection Data Types
 * 
 * Domain types for model connection management.
 */

import type { ModelProvider } from "@clawflare/types";

export type { ModelProvider } from "@clawflare/types";


export interface ModelConnection {
  id: string;
  workspaceId: string;
  displayName?: string;
  provider: ModelProvider;
  modelName: string;
  secretRefs: Record<string, string>;
  config: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;
}

export interface CreateModelConnectionParams {
  id?: string;
  workspaceId: string;
  displayName?: string;
  provider: string;
  modelName: string;
  secretRefs?: Record<string, string>;
  config?: Record<string, unknown>;
}

export interface UpdateModelConnectionParams {
  displayName?: string | null;
  provider?: string;
  modelName?: string;
  secretRefs?: Record<string, string>;
  config?: Record<string, unknown>;
}

// Model Connection Repository Implementation
// Manages AI model connections scoped to workspaces

import { createDb, type Db } from "./db.js";
import { modelConnections, sessions, workspaces } from "./schema.js";
import { DataLayerError } from "./errors.js";
import { and, count, desc, eq, isNull, notInArray } from "drizzle-orm";

function mapModelConnection(row: typeof modelConnections.$inferSelect): ModelConnection {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    displayName: row.displayName ?? undefined,
    provider: row.provider as ModelConnection["provider"],
    modelName: row.modelName,
    secretRefs: JSON.parse(row.secretRefsJson) as Record<string, string>,
    config: JSON.parse(row.configJson) as Record<string, unknown>,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt ?? undefined,
  };
}

export class ModelConnectionRepository {
  private readonly db: Db;

  constructor(db: Db | D1Database) {
    this.db = "query" in db ? db : createDb(db);
  }

  async create(params: CreateModelConnectionParams): Promise<ModelConnection> {
    const now = Date.now();
    const id = params.id ?? crypto.randomUUID();

    try {
      await this.db
        .insert(modelConnections)
        .values({
          id,
          workspaceId: params.workspaceId,
          displayName: params.displayName ?? null,
          provider: params.provider,
          modelName: params.modelName,
          secretRefsJson: JSON.stringify(params.secretRefs ?? {}),
          configJson: JSON.stringify(params.config ?? {}),
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        });

      const created = await this.get(params.workspaceId, id);
      if (!created) {
        throw new DataLayerError(
          "Failed to create model connection",
          "MODEL_CONNECTION_CREATE_FAILED"
        );
      }
      return created;
    } catch (error) {
      if (error instanceof DataLayerError) throw error;
      throw new DataLayerError(
        `Failed to create model connection: ${error instanceof Error ? error.message : String(error)}`,
        "MODEL_CONNECTION_CREATE_ERROR",
        error
      );
    }
  }

  async get(workspaceId: string, id: string): Promise<ModelConnection | null> {
    const row = await this.db.query.modelConnections.findFirst({
      where: and(
        eq(modelConnections.id, id),
        eq(modelConnections.workspaceId, workspaceId),
        isNull(modelConnections.deletedAt)
      ),
    });

    return row ? mapModelConnection(row) : null;
  }

  async list(workspaceId: string): Promise<ModelConnection[]> {
    const rows = await this.db.query.modelConnections.findMany({
      where: and(
        eq(modelConnections.workspaceId, workspaceId),
        isNull(modelConnections.deletedAt)
      ),
      orderBy: [desc(modelConnections.updatedAt)],
    });

    return rows.map(mapModelConnection);
  }

  async update(
    workspaceId: string,
    id: string,
    params: UpdateModelConnectionParams
  ): Promise<ModelConnection> {
    const setValues: Partial<typeof modelConnections.$inferInsert> = {};

    if (params.displayName !== undefined) {
      setValues.displayName = params.displayName ?? null;
    }

    if (params.provider !== undefined) {
      setValues.provider = params.provider;
    }

    if (params.modelName !== undefined) {
      setValues.modelName = params.modelName;
    }

    if (params.secretRefs !== undefined) {
      setValues.secretRefsJson = JSON.stringify(params.secretRefs);
    }

    if (params.config !== undefined) {
      setValues.configJson = JSON.stringify(params.config);
    }

    if (Object.keys(setValues).length === 0) {
      // Nothing to update, just fetch and return
      const existing = await this.get(workspaceId, id);
      if (!existing) {
        throw new DataLayerError(
          "Model connection not found",
          "MODEL_CONNECTION_NOT_FOUND"
        );
      }
      return existing;
    }

    await this.db
      .update(modelConnections)
      .set({ ...setValues, updatedAt: Date.now() })
      .where(
        and(
          eq(modelConnections.id, id),
          eq(modelConnections.workspaceId, workspaceId),
          isNull(modelConnections.deletedAt)
        )
      );

    const updated = await this.get(workspaceId, id);
    if (!updated) {
      throw new DataLayerError(
        "Failed to fetch updated model connection",
        "MODEL_CONNECTION_NOT_FOUND"
      );
    }
    return updated;
  }

  async softDelete(workspaceId: string, id: string): Promise<void> {
    // First check if this is the workspace default
    const defaultCheck = await this.db.query.workspaces.findFirst({
      columns: { defaultModelConnectionId: true },
      where: eq(workspaces.id, workspaceId),
    });

    if (defaultCheck?.defaultModelConnectionId === id) {
      throw new DataLayerError(
        "Cannot delete workspace default model connection. Set a new default first.",
        "MODEL_CONNECTION_IS_DEFAULT"
      );
    }

    // Check for active sessions using this model connection
    const activeSessions = await this.countActiveSessionReferences(workspaceId, id);
    if (activeSessions > 0) {
      throw new DataLayerError(
        `Cannot delete model connection with ${activeSessions} active session(s) referencing it.`,
        "MODEL_CONNECTION_ACTIVE_SESSIONS"
      );
    }

    const now = Date.now();
    const existing = await this.get(workspaceId, id);
    if (!existing) {
      throw new DataLayerError(
        "Model connection not found",
        "MODEL_CONNECTION_NOT_FOUND"
      );
    }

    await this.db
      .update(modelConnections)
      .set({ deletedAt: now, updatedAt: now })
      .where(
        and(
          eq(modelConnections.id, id),
          eq(modelConnections.workspaceId, workspaceId),
          isNull(modelConnections.deletedAt)
        )
      );
  }

  async setWorkspaceDefault(workspaceId: string, id: string | null): Promise<void> {
    if (id !== null) {
      // Verify the connection exists and belongs to the workspace
      const exists = await this.db.query.modelConnections.findFirst({
        columns: { id: true },
        where: and(
          eq(modelConnections.id, id),
          eq(modelConnections.workspaceId, workspaceId),
          isNull(modelConnections.deletedAt)
        ),
      });

      if (!exists) {
        throw new DataLayerError(
          "Model connection not found in workspace",
          "MODEL_CONNECTION_NOT_FOUND"
        );
      }
    }

    await this.db
      .update(workspaces)
      .set({ defaultModelConnectionId: id ?? null })
      .where(eq(workspaces.id, workspaceId));
  }

  async getWorkspaceDefault(workspaceId: string): Promise<ModelConnection | null> {
    const rows = await this.db
      .select({
        id: modelConnections.id,
        workspaceId: modelConnections.workspaceId,
        displayName: modelConnections.displayName,
        provider: modelConnections.provider,
        modelName: modelConnections.modelName,
        secretRefsJson: modelConnections.secretRefsJson,
        configJson: modelConnections.configJson,
        createdAt: modelConnections.createdAt,
        updatedAt: modelConnections.updatedAt,
        deletedAt: modelConnections.deletedAt,
      })
      .from(workspaces)
      .innerJoin(modelConnections, eq(modelConnections.id, workspaces.defaultModelConnectionId))
      .where(and(eq(workspaces.id, workspaceId), isNull(modelConnections.deletedAt)))
      .limit(1);

    return rows[0] ? mapModelConnection(rows[0]) : null;
  }

  async countActiveSessionReferences(workspaceId: string, id: string): Promise<number> {
    // Count sessions that reference this model connection and are not closed/expired/error
    const result = await this.db
      .select({ value: count() })
      .from(sessions)
      .where(
        and(
          eq(sessions.workspaceId, workspaceId),
          eq(sessions.modelConnectionId, id),
          notInArray(sessions.status, ["closed", "expired", "error"])
        )
      );

    return result[0]?.value ?? 0;
  }
}
