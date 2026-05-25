// D1 Workspace Repository Implementation
// Manages workspaces and user memberships for multi-tenant data access

import type {
  WorkspaceRepository,
  Workspace,
  WorkspaceMembership,
  WorkspaceRole,
} from "../interfaces.js";
import type { WorkspaceRow, WorkspaceMembershipRow } from "./row-mappers.js";
import { mapWorkspaceRow, mapWorkspaceMembershipRow } from "./row-mappers.js";

export class D1WorkspaceRepository implements WorkspaceRepository {
  constructor(private readonly db: D1Database) {}

  async getById(id: string): Promise<Workspace | null> {
    const row = await this.db
      .prepare(
        `
        SELECT id, slug, name, description, created_at, updated_at
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
        SELECT id, slug, name, description, created_at, updated_at
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
        INSERT INTO workspaces (id, slug, name, description, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `
      )
      .bind(workspace.id, workspace.slug, workspace.name, workspace.description ?? null, now, now)
      .run();

    return {
      ...workspace,
      createdAt: now,
      updatedAt: now,
    };
  }

  async listForUser(userId: string): Promise<Workspace[]> {
    const result = await this.db
      .prepare(
        `
        SELECT w.id, w.slug, w.name, w.description, w.created_at, w.updated_at
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