import { and, desc, eq } from "drizzle-orm";
import { createDb, type Db } from "./db.js";
import { containers, sessionContainer, sessions } from "./schema.js";
import { DataLayerError } from "./errors.js";

export type ContainerStatus = "active" | "destroyed";
export type SessionContainerRole = "attached";

export interface ContainerRecord {
  id: string;
  workspaceId: string;
  status: ContainerStatus;
  description?: string;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;
}

export interface SessionContainerLink {
  sessionId: string;
  containerId: string;
  workspaceId: string;
  role: SessionContainerRole;
  createdAt: number;
  updatedAt: number;
}

export interface CreateContainerParams {
  id: string;
  workspaceId: string;
  description?: string;
}

export interface LinkSessionContainerParams {
  workspaceId: string;
  sessionId: string;
  containerId: string;
  role?: SessionContainerRole;
}

function mapContainer(row: typeof containers.$inferSelect): ContainerRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    status: row.status as ContainerStatus,
    description: row.description ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt ?? undefined,
  };
}

function mapSessionContainer(row: typeof sessionContainer.$inferSelect): SessionContainerLink {
  return {
    sessionId: row.sessionId,
    containerId: row.containerId,
    workspaceId: row.workspaceId,
    role: row.role as SessionContainerRole,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class ContainerRepository {
  private readonly db: Db;

  constructor(db: Db | D1Database) {
    this.db = "query" in db ? db : createDb(db);
  }

  async create(params: CreateContainerParams): Promise<ContainerRecord> {
    const existing = await this.get(params.workspaceId, params.id);
    if (existing) {
      if (existing.status === "destroyed" || existing.deletedAt !== undefined) {
        await this.db
          .update(containers)
          .set({
            status: "active",
            description: params.description ?? existing.description,
            deletedAt: null,
            updatedAt: Date.now(),
          })
          .where(and(eq(containers.workspaceId, params.workspaceId), eq(containers.id, params.id)));
      } else {
        await this.touch(params.workspaceId, params.id, params.description);
      }

      const updated = await this.get(params.workspaceId, params.id);
      if (!updated) throw new DataLayerError("Failed to update container", "CONTAINER_UPDATE_FAILED");
      return updated;
    }

    const now = Date.now();
    await this.db.insert(containers).values({
      id: params.id,
      workspaceId: params.workspaceId,
      status: "active",
      description: params.description,
      createdAt: now,
      updatedAt: now,
    });

    const created = await this.get(params.workspaceId, params.id);
    if (!created) throw new DataLayerError("Failed to create container", "CONTAINER_CREATE_FAILED");
    return created;
  }

  async get(workspaceId: string, id: string): Promise<ContainerRecord | null> {
    const row = await this.db.query.containers.findFirst({
      where: and(eq(containers.workspaceId, workspaceId), eq(containers.id, id)),
    });
    return row ? mapContainer(row) : null;
  }

  async getById(id: string): Promise<ContainerRecord | null> {
    const row = await this.db.query.containers.findFirst({
      where: eq(containers.id, id),
    });
    return row ? mapContainer(row) : null;
  }

  async list(workspaceId: string): Promise<ContainerRecord[]> {
    const rows = await this.db.query.containers.findMany({
      where: eq(containers.workspaceId, workspaceId),
      orderBy: desc(containers.updatedAt),
    });
    return rows.map(mapContainer);
  }

  async touch(workspaceId: string, id: string, description?: string): Promise<void> {
    const update: Partial<typeof containers.$inferInsert> = {
      updatedAt: Date.now(),
    };
    if (description !== undefined) update.description = description;

    await this.db
      .update(containers)
      .set(update)
      .where(and(eq(containers.workspaceId, workspaceId), eq(containers.id, id)));
  }

  async markDestroyed(workspaceId: string, id: string): Promise<void> {
    const now = Date.now();
    await this.db
      .update(containers)
      .set({ status: "destroyed", deletedAt: now, updatedAt: now })
      .where(and(eq(containers.workspaceId, workspaceId), eq(containers.id, id)));
  }

  async linkSession(params: LinkSessionContainerParams): Promise<SessionContainerLink> {
    const session = await this.db.query.sessions.findFirst({
      where: and(eq(sessions.id, params.sessionId), eq(sessions.workspaceId, params.workspaceId)),
    });
    if (!session) {
      throw new DataLayerError("Session not found", "SESSION_NOT_FOUND");
    }

    const container = await this.get(params.workspaceId, params.containerId);
    if (!container) {
      throw new DataLayerError("Container not found", "CONTAINER_NOT_FOUND");
    }
    if (container.status !== "active" || container.deletedAt !== undefined) {
      throw new DataLayerError("Container has been removed", "CONTAINER_REMOVED");
    }

    const now = Date.now();
    await this.db
      .insert(sessionContainer)
      .values({
        sessionId: params.sessionId,
        containerId: params.containerId,
        workspaceId: params.workspaceId,
        role: params.role ?? "attached",
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [sessionContainer.sessionId, sessionContainer.containerId],
        set: {
          role: "attached",
          updatedAt: now,
        },
      });

    const link = await this.getSessionLink(params.workspaceId, params.sessionId, params.containerId);
    if (!link) throw new DataLayerError("Failed to link container to session", "SESSION_CONTAINER_LINK_FAILED");
    return link;
  }

  async getSessionLink(
    workspaceId: string,
    sessionId: string,
    containerId: string
  ): Promise<SessionContainerLink | null> {
    const row = await this.db.query.sessionContainer.findFirst({
      where: and(
        eq(sessionContainer.workspaceId, workspaceId),
        eq(sessionContainer.sessionId, sessionId),
        eq(sessionContainer.containerId, containerId)
      ),
    });
    return row ? mapSessionContainer(row) : null;
  }

  async listForSession(workspaceId: string, sessionId: string): Promise<ContainerRecord[]> {
    const rows = await this.db
      .select({
        id: containers.id,
        workspaceId: containers.workspaceId,
        status: containers.status,
        description: containers.description,
        createdAt: containers.createdAt,
        updatedAt: containers.updatedAt,
        deletedAt: containers.deletedAt,
      })
      .from(sessionContainer)
      .innerJoin(containers, eq(containers.id, sessionContainer.containerId))
      .where(
        and(
          eq(sessionContainer.workspaceId, workspaceId),
          eq(sessionContainer.sessionId, sessionId)
        )
      )
      .orderBy(desc(sessionContainer.updatedAt));

    return rows.map((row) => mapContainer(row));
  }

  async listLinksForContainer(workspaceId: string, containerId: string): Promise<SessionContainerLink[]> {
    const rows = await this.db.query.sessionContainer.findMany({
      where: and(
        eq(sessionContainer.workspaceId, workspaceId),
        eq(sessionContainer.containerId, containerId)
      ),
    });
    return rows.map(mapSessionContainer);
  }

  async listLinksForContainerId(containerId: string): Promise<SessionContainerLink[]> {
    const rows = await this.db.query.sessionContainer.findMany({
      where: eq(sessionContainer.containerId, containerId),
      orderBy: desc(sessionContainer.updatedAt),
    });
    return rows.map(mapSessionContainer);
  }

  async unlinkSession(workspaceId: string, sessionId: string, containerId: string): Promise<void> {
    await this.db
      .delete(sessionContainer)
      .where(
        and(
          eq(sessionContainer.workspaceId, workspaceId),
          eq(sessionContainer.sessionId, sessionId),
          eq(sessionContainer.containerId, containerId)
        )
      );
  }

  async unlinkAllSessions(workspaceId: string, containerId: string): Promise<void> {
    await this.db
      .delete(sessionContainer)
      .where(and(eq(sessionContainer.workspaceId, workspaceId), eq(sessionContainer.containerId, containerId)));
  }
}
