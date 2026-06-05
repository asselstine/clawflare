/**
 * Workspace Data Types
 * 
 * Domain types for workspace and user management.
 */


export interface User {
  id: string;
  email: string;
  displayName?: string | null;
  emailVerifiedAt?: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface CreateUserParams {
  email: string;
  displayName?: string;
  emailVerifiedAt?: number;
}

export interface Workspace {
  id: string;
  slug: string;
  name: string;
  description?: string | null;
  defaultModelId?: string | null;
  createdAt: number;
  updatedAt: number;
}

export type WorkspaceRole = "owner" | "admin" | "member" | "viewer";

export interface WorkspaceMembership {
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
  joinedAt: number;
  updatedAt: number;
}

// Workspace Repository Implementation
// Manages workspaces and user memberships for multi-tenant data access

import { createDb, type Db } from "./db.js";
import {
  users,
  workspaceMemberships,
  workspaces,
} from "./schema.js";
import { desc, eq, and } from "drizzle-orm";

/**
 * User repository
 */
export class UserRepository {
  private readonly db: Db;

  constructor(db: Db | D1Database) {
    this.db = "query" in db ? db : createDb(db);
  }

  async getById(id: string): Promise<User | null> {
    const row = await this.db.query.users.findFirst({
      where: eq(users.id, id),
    });

    return row ?? null;
  }

  async getByEmail(email: string): Promise<User | null> {
    const row = await this.db.query.users.findFirst({
      where: eq(users.email, email),
    });

    return row ?? null;
  }

  async create(id: string, params: CreateUserParams): Promise<User> {
    const now = Date.now();

    await this.db.insert(users).values({
      id,
      email: params.email,
      displayName: params.displayName ?? null,
      emailVerifiedAt: params.emailVerifiedAt ?? null,
      createdAt: now,
      updatedAt: now,
    });

    return {
      id,
      email: params.email,
      displayName: params.displayName ?? null,
      emailVerifiedAt: params.emailVerifiedAt ?? null,
      createdAt: now,
      updatedAt: now,
    };
  }

  async setEmailVerified(userId: string): Promise<void> {
    const now = Date.now();
    await this.db
      .update(users)
      .set({ emailVerifiedAt: now, updatedAt: now })
      .where(eq(users.id, userId));
  }
}

/**
 * Workspace repository
 */
export class WorkspaceRepository {
  private readonly db: Db;

  constructor(db: Db | D1Database) {
    this.db = "query" in db ? db : createDb(db);
  }

  async getById(id: string): Promise<Workspace | null> {
    const row = await this.db.query.workspaces.findFirst({
      where: eq(workspaces.id, id),
    });

    return row ?? null;
  }

  async getBySlug(slug: string): Promise<Workspace | null> {
    const row = await this.db.query.workspaces.findFirst({
      where: eq(workspaces.slug, slug),
    });

    return row ?? null;
  }

  async create(
    workspace: Omit<Workspace, "createdAt" | "updatedAt" | "defaultModelId"> & {
      defaultModelId?: string | null;
    }
  ): Promise<Workspace> {
    const now = Date.now();

    await this.db.insert(workspaces).values({
      id: workspace.id,
      slug: workspace.slug,
      name: workspace.name,
      description: workspace.description ?? null,
      defaultModelId: workspace.defaultModelId ?? null,
      createdAt: now,
      updatedAt: now,
    });

    return {
      ...workspace,
      description: workspace.description ?? null,
      defaultModelId: workspace.defaultModelId ?? null,
      createdAt: now,
      updatedAt: now,
    };
  }

  async listForUser(userId: string): Promise<Workspace[]> {
    const rows = await this.db
      .select({
        id: workspaces.id,
        slug: workspaces.slug,
        name: workspaces.name,
        description: workspaces.description,
        createdAt: workspaces.createdAt,
        updatedAt: workspaces.updatedAt,
        defaultModelId: workspaces.defaultModelId,
      })
      .from(workspaces)
      .innerJoin(
        workspaceMemberships,
        eq(workspaceMemberships.workspaceId, workspaces.id)
      )
      .where(eq(workspaceMemberships.userId, userId))
      .orderBy(desc(workspaces.updatedAt));

    return rows;
  }

  async isMember(workspaceId: string, userId: string): Promise<boolean> {
    const row = await this.db.query.workspaceMemberships.findFirst({
      columns: { workspaceId: true },
      where: and(
        eq(workspaceMemberships.workspaceId, workspaceId),
        eq(workspaceMemberships.userId, userId)
      ),
    });

    return Boolean(row);
  }

  async getUserRole(workspaceId: string, userId: string): Promise<WorkspaceRole | null> {
    const row = await this.db.query.workspaceMemberships.findFirst({
      columns: { role: true },
      where: and(
        eq(workspaceMemberships.workspaceId, workspaceId),
        eq(workspaceMemberships.userId, userId)
      ),
    });

    return (row?.role as WorkspaceRole) ?? null;
  }

  async addMembership(
    membership: Omit<WorkspaceMembership, "joinedAt" | "updatedAt">
  ): Promise<void> {
    const now = Date.now();

    await this.db
      .insert(workspaceMemberships)
      .values({
        workspaceId: membership.workspaceId,
        userId: membership.userId,
        role: membership.role,
        joinedAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [workspaceMemberships.workspaceId, workspaceMemberships.userId],
        set: {
          role: membership.role,
          updatedAt: now,
        },
      });
  }

  async removeMembership(workspaceId: string, userId: string): Promise<void> {
    await this.db
      .delete(workspaceMemberships)
      .where(
        and(
          eq(workspaceMemberships.workspaceId, workspaceId),
          eq(workspaceMemberships.userId, userId)
        )
      );
  }

  /**
   * Get all memberships for a workspace
   * Useful for admin operations
   */
  async getWorkspaceMembers(workspaceId: string): Promise<WorkspaceMembership[]> {
    const rows = await this.db.query.workspaceMemberships.findMany({
      where: eq(workspaceMemberships.workspaceId, workspaceId),
      orderBy: (memberships, { asc }) => [asc(memberships.joinedAt)],
    });

    return rows;
  }
}
