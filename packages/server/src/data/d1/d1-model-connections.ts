// D1 Model Connection Repository Implementation
// Manages AI model connections scoped to workspaces

import type {
  ModelConnectionRepository,
  ModelConnection,
  CreateModelConnectionParams,
  UpdateModelConnectionParams,
} from "../interfaces.js";
import type { ModelConnectionRow } from "./row-mappers.js";
import { mapModelConnectionRow } from "./row-mappers.js";
import { DataLayerError } from "../errors.js";

// Helper type for D1 result
interface D1ExecResult {
  success: boolean;
  meta?: { changes?: number };
}

export class D1ModelConnectionRepository implements ModelConnectionRepository {
  constructor(private readonly db: D1Database) {}

  async create(params: CreateModelConnectionParams): Promise<ModelConnection> {
    const now = Date.now();
    const id = params.id ?? crypto.randomUUID();

    try {
      const result = await this.db
        .prepare(
          `
          INSERT INTO model_connections (
            id, workspace_id, display_name, provider, model_name,
            secret_refs_json, config_json, created_at, updated_at, deleted_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
        `
        )
        .bind(
          id,
          params.workspaceId,
          params.displayName ?? null,
          params.provider,
          params.modelName,
          JSON.stringify(params.secretRefs ?? {}),
          JSON.stringify(params.config ?? {}),
          now,
          now
        )
        .run();

      const d1Result = result as unknown as D1ExecResult;
      if (!d1Result.success && d1Result.meta?.changes === 0) {
        throw new DataLayerError(
          "Failed to create model connection - no rows affected",
          "MODEL_CONNECTION_CREATE_FAILED"
        );
      }

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
    const row = await this.db
      .prepare(
        `
        SELECT 
          id, workspace_id, display_name, provider, model_name,
          secret_refs_json, config_json, created_at, updated_at, deleted_at
        FROM model_connections
        WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL
      `
      )
      .bind(id, workspaceId)
      .first<ModelConnectionRow>();

    return row ? mapModelConnectionRow(row) : null;
  }

  async list(workspaceId: string): Promise<ModelConnection[]> {
    const result = await this.db
      .prepare(
        `
        SELECT 
          id, workspace_id, display_name, provider, model_name,
          secret_refs_json, config_json, created_at, updated_at, deleted_at
        FROM model_connections
        WHERE workspace_id = ? AND deleted_at IS NULL
        ORDER BY updated_at DESC
      `
      )
      .bind(workspaceId)
      .all<ModelConnectionRow>();

    return result.results.map(mapModelConnectionRow);
  }

  async update(
    workspaceId: string,
    id: string,
    params: UpdateModelConnectionParams
  ): Promise<ModelConnection> {
    const setClauses: string[] = [];
    const bindings: (string | number | null)[] = [];

    if (params.displayName !== undefined) {
      setClauses.push("display_name = ?");
      bindings.push(params.displayName ?? null);
    }

    if (params.provider !== undefined) {
      setClauses.push("provider = ?");
      bindings.push(params.provider);
    }

    if (params.modelName !== undefined) {
      setClauses.push("model_name = ?");
      bindings.push(params.modelName);
    }

    if (params.secretRefs !== undefined) {
      setClauses.push("secret_refs_json = ?");
      bindings.push(JSON.stringify(params.secretRefs));
    }

    if (params.config !== undefined) {
      setClauses.push("config_json = ?");
      bindings.push(JSON.stringify(params.config));
    }

    if (setClauses.length === 0) {
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

    setClauses.push("updated_at = ?");
    bindings.push(Date.now());

    // Add workspace check + id
    bindings.push(id, workspaceId);

    const result = await this.db
      .prepare(
        `
        UPDATE model_connections
        SET ${setClauses.join(", ")}
        WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL
      `
      )
      .bind(...bindings)
      .run();

    const d1Result = result as unknown as D1ExecResult;
    if (!d1Result.success && d1Result.meta?.changes === 0) {
      throw new DataLayerError(
        "Model connection not found or no changes made",
        "MODEL_CONNECTION_UPDATE_FAILED"
      );
    }

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
    const defaultCheck = await this.db
      .prepare(
        `
        SELECT default_model_connection_id
        FROM workspaces
        WHERE id = ?
      `
      )
      .bind(workspaceId)
      .first<{ default_model_connection_id: string | null }>();

    if (defaultCheck?.default_model_connection_id === id) {
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
    const result = await this.db
      .prepare(
        `
        UPDATE model_connections
        SET deleted_at = ?, updated_at = ?
        WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL
      `
      )
      .bind(now, now, id, workspaceId)
      .run();

    const d1Result = result as unknown as D1ExecResult;
    if (!d1Result.success && d1Result.meta?.changes === 0) {
      throw new DataLayerError(
        "Model connection not found",
        "MODEL_CONNECTION_NOT_FOUND"
      );
    }
  }

  async setWorkspaceDefault(workspaceId: string, id: string | null): Promise<void> {
    if (id !== null) {
      // Verify the connection exists and belongs to the workspace
      const exists = await this.db
        .prepare(
          `
          SELECT 1
          FROM model_connections
          WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL
        `
        )
        .bind(id, workspaceId)
        .first<{ "1": number }>();

      if (!exists) {
        throw new DataLayerError(
          "Model connection not found in workspace",
          "MODEL_CONNECTION_NOT_FOUND"
        );
      }
    }

    await this.db
      .prepare(
        `
        UPDATE workspaces
        SET default_model_connection_id = ?
        WHERE id = ?
      `
      )
      .bind(id ?? null, workspaceId)
      .run();
  }

  async getWorkspaceDefault(workspaceId: string): Promise<ModelConnection | null> {
    const row = await this.db
      .prepare(
        `
        SELECT 
          mc.id, mc.workspace_id, mc.display_name, mc.provider, mc.model_name,
          mc.secret_refs_json, mc.config_json, mc.created_at, mc.updated_at, mc.deleted_at
        FROM workspaces w
        JOIN model_connections mc ON mc.id = w.default_model_connection_id
        WHERE w.id = ? AND mc.deleted_at IS NULL
      `
      )
      .bind(workspaceId)
      .first<ModelConnectionRow>();

    return row ? mapModelConnectionRow(row) : null;
  }

  async countActiveSessionReferences(workspaceId: string, id: string): Promise<number> {
    // Count sessions that reference this model connection and are not closed/expired/error
    const result = await this.db
      .prepare(
        `
        SELECT COUNT(*) as count
        FROM sessions
        WHERE workspace_id = ?
          AND model_connection_id = ?
          AND status NOT IN ('closed', 'expired', 'error')
      `
      )
      .bind(workspaceId, id)
      .first<{ count: number }>();

    return result?.count ?? 0;
  }
}
