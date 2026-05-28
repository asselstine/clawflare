// D1 Workspace Repository Implementation
// Manages workspaces and user memberships for multi-tenant data access

import type {
  WorkspaceRepository,
  Workspace,
  WorkspaceMembership,
  WorkspaceRole,
  UserRepository,
  User,
  CreateUserParams,
} from "../workspaces.js";
import type { WorkspaceRow, WorkspaceMembershipRow } from "./row-mappers.js";
import { mapWorkspaceRow, mapWorkspaceMembershipRow } from "./row-mappers.js";

/**
 * D1-based user repository
 */
export class D1UserRepository implements UserRepository {
  constructor(private readonly db: D1Database) {}

  async getById(id: string): Promise<User | null> {
    const row = await this.db
      .prepare(
        `
        SELECT id, email, display_name, email_verified_at, created_at, updated_at
        FROM users
        WHERE id = ?
      `
      )
      .bind(id)
      .first<{
        id: string;
        email: string;
        display_name: string | null;
        email_verified_at: number | null;
        created_at: number;
        updated_at: number;
      }>();

    if (!row) return null;

    return {
      id: row.id,
      email: row.email,
      displayName: row.display_name ?? undefined,
      emailVerifiedAt: row.email_verified_at ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async getByEmail(email: string): Promise<User | null> {
    const row = await this.db
      .prepare(
        `
        SELECT id, email, display_name, email_verified_at, created_at, updated_at
        FROM users
        WHERE email = ?
      `
      )
      .bind(email)
      .first<{
        id: string;
        email: string;
        display_name: string | null;
        email_verified_at: number | null;
        created_at: number;
        updated_at: number;
      }>();

    if (!row) return null;

    return {
      id: row.id,
      email: row.email,
      displayName: row.display_name ?? undefined,
      emailVerifiedAt: row.email_verified_at ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async create(id: string, params: CreateUserParams): Promise<User> {
    const now = Date.now();

    await this.db
      .prepare(
        `
        INSERT INTO users (id, email, display_name, email_verified_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `
      )
      .bind(id, params.email, params.displayName ?? null, params.emailVerifiedAt ?? null, now, now)
      .run();

    return {
      id,
      email: params.email,
      displayName: params.displayName,
      emailVerifiedAt: params.emailVerifiedAt,
      createdAt: now,
      updatedAt: now,
    };
  }

  async setEmailVerified(userId: string): Promise<void> {
    await this.db
      .prepare(
        `
        UPDATE users
        SET email_verified_at = ?, updated_at = ?
        WHERE id = ?
      `
      )
      .bind(Date.now(), Date.now(), userId)
      .run();
  }
}

/**
 * D1-based workspace repository
 */
export class D1WorkspaceRepository implements WorkspaceRepository {
  constructor(private readonly db: D1Database) {}

  async getById(id: string): Promise<Workspace | null> {
    const row = await this.db
      .prepare(
        `
        SELECT id, slug, name, description, created_at, updated_at, default_model_connection_id
        FROM workspaces
        WHERE id = ?
      `
      )
      .bind(id)
      .first<WorkspaceRow>();

    return row ? mapWorkspaceRow(row) : null;
  }

  async getBySlug(slug: string): Promise<Workspace | null> {
    const row = await this.db
      .prepare(
        `
        SELECT id, slug, name, description, created_at, updated_at, default_model_connection_id
        FROM workspaces
        WHERE slug = ?
      `
      )
      .bind(slug)
      .first<WorkspaceRow>();

    return row ? mapWorkspaceRow(row) : null;
  }

  async create(
    workspace: Omit<Workspace, "createdAt" | "updatedAt">
  ): Promise<Workspace> {
    const now = Date.now();

    await this.db
      .prepare(
        `
        INSERT INTO workspaces (id, slug, name, description, created_at, updated_at, default_model_connection_id)
        VALUES (?, ?, ?, ?, ?, ?, NULL)
      `
      )
      .bind(workspace.id, workspace.slug, workspace.name, workspace.description ?? null, now, now)
      .run();

    return {
      ...workspace,
      defaultModelConnectionId: undefined,
      createdAt: now,
      updatedAt: now,
    };
  }

  async listForUser(userId: string): Promise<Workspace[]> {
    const result = await this.db
      .prepare(
        `
        SELECT w.id, w.slug, w.name, w.description, w.created_at, w.updated_at, w.default_model_connection_id
        FROM workspaces w
        INNER JOIN workspace_memberships m ON m.workspace_id = w.id
        WHERE m.user_id = ?
        ORDER BY w.updated_at DESC
      `
      )
      .bind(userId)
      .all<WorkspaceRow>();

    return result.results.map(mapWorkspaceRow);
  }

  async isMember(workspaceId: string, userId: string): Promise<boolean> {
    const row = await this.db
      .prepare(
        `
        SELECT 1 as is_member
        FROM workspace_memberships
        WHERE workspace_id = ? AND user_id = ?
      `
      )
      .bind(workspaceId, userId)
      .first<{ is_member: number }>();

    return row?.is_member === 1;
  }

  async getUserRole(workspaceId: string, userId: string): Promise<WorkspaceRole | null> {
    const row = await this.db
      .prepare(
        `
        SELECT role
        FROM workspace_memberships
        WHERE workspace_id = ? AND user_id = ?
      `
      )
      .bind(workspaceId, userId)
      .first<{ role: string }>();

    return (row?.role as WorkspaceRole) ?? null;
  }

  async addMembership(
    membership: Omit<WorkspaceMembership, "joinedAt" | "updatedAt">
  ): Promise<void> {
    const now = Date.now();

    await this.db
      .prepare(
        `
        INSERT INTO workspace_memberships (
          workspace_id, user_id, role, joined_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(workspace_id, user_id) DO UPDATE SET
          role = excluded.role,
          updated_at = excluded.updated_at
      `
      )
      .bind(
        membership.workspaceId,
        membership.userId,
        membership.role,
        now,
        now
      )
      .run();
  }

  async removeMembership(workspaceId: string, userId: string): Promise<void> {
    await this.db
      .prepare(
        `
        DELETE FROM workspace_memberships
        WHERE workspace_id = ? AND user_id = ?
      `
      )
      .bind(workspaceId, userId)
      .run();
  }

  /**
   * Get all memberships for a workspace
   * Useful for admin operations
   */
  async getWorkspaceMembers(workspaceId: string): Promise<WorkspaceMembership[]> {
    const result = await this.db
      .prepare(
        `
        SELECT workspace_id, user_id, role, joined_at, updated_at
        FROM workspace_memberships
        WHERE workspace_id = ?
        ORDER BY joined_at ASC
      `
      )
      .bind(workspaceId)
      .all<WorkspaceMembershipRow>();

    return result.results.map(mapWorkspaceMembershipRow);
  }
}
