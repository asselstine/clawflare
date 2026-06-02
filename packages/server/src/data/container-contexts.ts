import { and, eq } from "drizzle-orm";
import { createDb, type Db } from "./db.js";
import { containerContexts } from "./schema.js";
import { DataLayerError } from "./errors.js";

export interface ContainerContext {
  containerId: string;
  workspaceId: string;
  sessionId: string;
  createdAt: number;
  updatedAt: number;
}

export interface RegisterContainerContextParams {
  containerId: string;
  workspaceId: string;
  sessionId: string;
}

function mapContainerContext(row: typeof containerContexts.$inferSelect): ContainerContext {
  return {
    containerId: row.containerId,
    workspaceId: row.workspaceId,
    sessionId: row.sessionId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class ContainerContextRepository {
  private readonly db: Db;

  constructor(db: Db | D1Database) {
    this.db = "query" in db ? db : createDb(db);
  }

  async register(params: RegisterContainerContextParams): Promise<ContainerContext> {
    const existing = await this.get(params.containerId);
    if (existing) {
      if (
        existing.workspaceId !== params.workspaceId ||
        existing.sessionId !== params.sessionId
      ) {
        throw new DataLayerError(
          `Container "${params.containerId}" is already owned by another session`,
          "CONTAINER_CONTEXT_CONFLICT"
        );
      }

      await this.db
        .update(containerContexts)
        .set({ updatedAt: Date.now() })
        .where(eq(containerContexts.containerId, params.containerId));

      const updated = await this.get(params.containerId);
      if (!updated) {
        throw new DataLayerError(
          "Failed to update container context",
          "CONTAINER_CONTEXT_UPDATE_FAILED"
        );
      }
      return updated;
    }

    const now = Date.now();
    await this.db.insert(containerContexts).values({
      containerId: params.containerId,
      workspaceId: params.workspaceId,
      sessionId: params.sessionId,
      createdAt: now,
      updatedAt: now,
    });

    const created = await this.get(params.containerId);
    if (!created) {
      throw new DataLayerError(
        "Failed to create container context",
        "CONTAINER_CONTEXT_CREATE_FAILED"
      );
    }
    return created;
  }

  async get(containerId: string): Promise<ContainerContext | null> {
    const row = await this.db.query.containerContexts.findFirst({
      where: eq(containerContexts.containerId, containerId),
    });
    return row ? mapContainerContext(row) : null;
  }

  async listForSession(workspaceId: string, sessionId: string): Promise<ContainerContext[]> {
    const rows = await this.db.query.containerContexts.findMany({
      where: and(
        eq(containerContexts.workspaceId, workspaceId),
        eq(containerContexts.sessionId, sessionId)
      ),
    });
    return rows.map(mapContainerContext);
  }

  async deleteForSession(workspaceId: string, sessionId: string, containerId: string): Promise<void> {
    await this.db
      .delete(containerContexts)
      .where(
        and(
          eq(containerContexts.workspaceId, workspaceId),
          eq(containerContexts.sessionId, sessionId),
          eq(containerContexts.containerId, containerId)
        )
      );
  }
}
