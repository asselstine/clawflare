/**
 * Model and provider data types.
 */

import type { ModelProvider } from "@clawflare/types";

export type { ModelProvider } from "@clawflare/types";

export interface Provider {
  id: string;
  workspaceId: string;
  displayName?: string;
  provider: ModelProvider;
  secretRefs: Record<string, string>;
  config: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;
}

export interface Model {
  id: string;
  workspaceId: string;
  providerId: string;
  displayName?: string;
  provider: ModelProvider;
  providerDisplayName?: string;
  modelName: string;
  secretRefs: Record<string, string>;
  providerConfig: Record<string, unknown>;
  config: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;
}

export interface CreateProviderParams {
  id?: string;
  workspaceId: string;
  displayName?: string;
  provider: string;
  secretRefs?: Record<string, string>;
  config?: Record<string, unknown>;
}

export interface UpdateProviderParams {
  displayName?: string | null;
  secretRefs?: Record<string, string>;
  config?: Record<string, unknown>;
}

export interface DeleteProviderResult {
  providerId: string;
  deletedModelIds: string[];
  clearedDefaultModelId?: string;
}

export interface CreateModelParams {
  id?: string;
  workspaceId: string;
  providerId: string;
  displayName?: string;
  modelName: string;
  config?: Record<string, unknown>;
}

export interface UpdateModelParams {
  displayName?: string | null;
  modelName?: string;
  config?: Record<string, unknown>;
}

import { and, count, desc, eq, isNull, notInArray } from "drizzle-orm";
import { createDb, type Db } from "./db.js";
import { models, providers, sessions, workspaces } from "./schema.js";
import { DataLayerError } from "./errors.js";

function mapProvider(row: typeof providers.$inferSelect): Provider {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    displayName: row.displayName ?? undefined,
    provider: row.provider as Provider["provider"],
    secretRefs: JSON.parse(row.secretRefsJson) as Record<string, string>,
    config: JSON.parse(row.configJson) as Record<string, unknown>,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt ?? undefined,
  };
}

function mapModel(row: {
  id: string;
  workspaceId: string;
  providerId: string;
  displayName: string | null;
  provider: string;
  providerDisplayName: string | null;
  modelName: string;
  secretRefsJson: string;
  providerConfigJson: string;
  configJson: string;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}): Model {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    providerId: row.providerId,
    displayName: row.displayName ?? undefined,
    provider: row.provider as Model["provider"],
    providerDisplayName: row.providerDisplayName ?? undefined,
    modelName: row.modelName,
    secretRefs: JSON.parse(row.secretRefsJson) as Record<string, string>,
    providerConfig: JSON.parse(row.providerConfigJson) as Record<string, unknown>,
    config: JSON.parse(row.configJson) as Record<string, unknown>,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt ?? undefined,
  };
}

export class ProviderRepository {
  private readonly db: Db;

  constructor(db: Db | D1Database) {
    this.db = "query" in db ? db : createDb(db);
  }

  async create(params: CreateProviderParams): Promise<Provider> {
    const now = Date.now();
    const id = params.id ?? crypto.randomUUID();

    try {
      await this.db.insert(providers).values({
        id,
        workspaceId: params.workspaceId,
        displayName: params.displayName ?? null,
        provider: params.provider,
        secretRefsJson: JSON.stringify(params.secretRefs ?? {}),
        configJson: JSON.stringify(params.config ?? {}),
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      });

      const created = await this.get(params.workspaceId, id);
      if (!created) {
        throw new DataLayerError("Failed to create provider", "PROVIDER_CREATE_FAILED");
      }
      return created;
    } catch (error) {
      if (error instanceof DataLayerError) throw error;
      throw new DataLayerError(
        `Failed to create provider: ${error instanceof Error ? error.message : String(error)}`,
        "PROVIDER_CREATE_ERROR",
        error
      );
    }
  }

  async get(workspaceId: string, id: string): Promise<Provider | null> {
    const row = await this.db.query.providers.findFirst({
      where: and(eq(providers.id, id), eq(providers.workspaceId, workspaceId), isNull(providers.deletedAt)),
    });
    return row ? mapProvider(row) : null;
  }

  async list(workspaceId: string): Promise<Provider[]> {
    const rows = await this.db.query.providers.findMany({
      where: and(eq(providers.workspaceId, workspaceId), isNull(providers.deletedAt)),
      orderBy: [desc(providers.updatedAt)],
    });
    return rows.map(mapProvider);
  }

  async update(workspaceId: string, id: string, params: UpdateProviderParams): Promise<Provider> {
    const setValues: Partial<typeof providers.$inferInsert> = {};
    if (params.displayName !== undefined) setValues.displayName = params.displayName ?? null;
    if (params.secretRefs !== undefined) setValues.secretRefsJson = JSON.stringify(params.secretRefs);
    if (params.config !== undefined) setValues.configJson = JSON.stringify(params.config);

    if (Object.keys(setValues).length === 0) {
      const existing = await this.get(workspaceId, id);
      if (!existing) throw new DataLayerError("Provider not found", "PROVIDER_NOT_FOUND");
      return existing;
    }

    await this.db
      .update(providers)
      .set({ ...setValues, updatedAt: Date.now() })
      .where(and(eq(providers.id, id), eq(providers.workspaceId, workspaceId), isNull(providers.deletedAt)));

    const updated = await this.get(workspaceId, id);
    if (!updated) throw new DataLayerError("Failed to fetch updated provider", "PROVIDER_NOT_FOUND");
    return updated;
  }

  async softDeleteWithModels(workspaceId: string, id: string): Promise<DeleteProviderResult> {
    const existing = await this.get(workspaceId, id);
    if (!existing) throw new DataLayerError("Provider not found", "PROVIDER_NOT_FOUND");

    const activeSessions = await this.db
      .select({ value: count() })
      .from(sessions)
      .innerJoin(models, eq(sessions.modelId, models.id))
      .where(
        and(
          eq(models.workspaceId, workspaceId),
          eq(models.providerId, id),
          isNull(models.deletedAt),
          eq(sessions.workspaceId, workspaceId),
          notInArray(sessions.status, ["closed", "expired", "error"])
        )
      );

    const activeSessionCount = activeSessions[0]?.value ?? 0;
    if (activeSessionCount > 0) {
      throw new DataLayerError(
        `Cannot delete provider with ${activeSessionCount} active session(s) using its models.`,
        "PROVIDER_ACTIVE_SESSIONS"
      );
    }

    const providerModels = await this.db
      .select({ id: models.id })
      .from(models)
      .where(and(eq(models.workspaceId, workspaceId), eq(models.providerId, id), isNull(models.deletedAt)));
    const deletedModelIds = providerModels.map((model) => model.id);

    const workspace = await this.db.query.workspaces.findFirst({
      columns: { defaultModelId: true },
      where: eq(workspaces.id, workspaceId),
    });

    const now = Date.now();
    await this.db
      .update(models)
      .set({ deletedAt: now, updatedAt: now })
      .where(and(eq(models.workspaceId, workspaceId), eq(models.providerId, id), isNull(models.deletedAt)));

    const clearedDefaultModelId =
      workspace?.defaultModelId && deletedModelIds.includes(workspace.defaultModelId)
        ? workspace.defaultModelId
        : undefined;
    if (clearedDefaultModelId) {
      await this.db.update(workspaces).set({ defaultModelId: null }).where(eq(workspaces.id, workspaceId));
    }

    await this.db
      .update(providers)
      .set({ deletedAt: now, updatedAt: now })
      .where(and(eq(providers.id, id), eq(providers.workspaceId, workspaceId), isNull(providers.deletedAt)));

    return { providerId: id, deletedModelIds, clearedDefaultModelId };
  }
}

export class ModelRepository {
  private readonly db: Db;

  constructor(db: Db | D1Database) {
    this.db = "query" in db ? db : createDb(db);
  }

  async create(params: CreateModelParams): Promise<Model> {
    const now = Date.now();
    const id = params.id ?? crypto.randomUUID();

    try {
      await this.db.insert(models).values({
        id,
        workspaceId: params.workspaceId,
        providerId: params.providerId,
        displayName: params.displayName ?? null,
        modelName: params.modelName,
        configJson: JSON.stringify(params.config ?? {}),
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      });

      const created = await this.get(params.workspaceId, id);
      if (!created) throw new DataLayerError("Failed to create model", "MODEL_CREATE_FAILED");
      return created;
    } catch (error) {
      if (error instanceof DataLayerError) throw error;
      throw new DataLayerError(
        `Failed to create model: ${error instanceof Error ? error.message : String(error)}`,
        "MODEL_CREATE_ERROR",
        error
      );
    }
  }

  async get(workspaceId: string, id: string): Promise<Model | null> {
    const rows = await this.selectBase()
      .where(and(eq(models.id, id), eq(models.workspaceId, workspaceId), isNull(models.deletedAt), isNull(providers.deletedAt)))
      .limit(1);
    return rows[0] ? mapModel(rows[0]) : null;
  }

  async list(workspaceId: string): Promise<Model[]> {
    const rows = await this.selectBase()
      .where(and(eq(models.workspaceId, workspaceId), isNull(models.deletedAt), isNull(providers.deletedAt)))
      .orderBy(desc(models.updatedAt));
    return rows.map(mapModel);
  }

  async update(workspaceId: string, id: string, params: UpdateModelParams): Promise<Model> {
    const setValues: Partial<typeof models.$inferInsert> = {};
    if (params.displayName !== undefined) setValues.displayName = params.displayName ?? null;
    if (params.modelName !== undefined) setValues.modelName = params.modelName;
    if (params.config !== undefined) setValues.configJson = JSON.stringify(params.config);

    if (Object.keys(setValues).length === 0) {
      const existing = await this.get(workspaceId, id);
      if (!existing) throw new DataLayerError("Model not found", "MODEL_NOT_FOUND");
      return existing;
    }

    await this.db
      .update(models)
      .set({ ...setValues, updatedAt: Date.now() })
      .where(and(eq(models.id, id), eq(models.workspaceId, workspaceId), isNull(models.deletedAt)));

    const updated = await this.get(workspaceId, id);
    if (!updated) throw new DataLayerError("Failed to fetch updated model", "MODEL_NOT_FOUND");
    return updated;
  }

  async softDelete(workspaceId: string, id: string): Promise<void> {
    const defaultCheck = await this.db.query.workspaces.findFirst({
      columns: { defaultModelId: true },
      where: eq(workspaces.id, workspaceId),
    });

    if (defaultCheck?.defaultModelId === id) {
      throw new DataLayerError("Cannot delete workspace default model. Set a new default first.", "MODEL_IS_DEFAULT");
    }

    const activeSessions = await this.countActiveSessionReferences(workspaceId, id);
    if (activeSessions > 0) {
      throw new DataLayerError(
        `Cannot delete model with ${activeSessions} active session(s) referencing it.`,
        "MODEL_ACTIVE_SESSIONS"
      );
    }

    const existing = await this.get(workspaceId, id);
    if (!existing) throw new DataLayerError("Model not found", "MODEL_NOT_FOUND");

    const now = Date.now();
    await this.db
      .update(models)
      .set({ deletedAt: now, updatedAt: now })
      .where(and(eq(models.id, id), eq(models.workspaceId, workspaceId), isNull(models.deletedAt)));
  }

  async setWorkspaceDefault(workspaceId: string, id: string | null): Promise<void> {
    if (id !== null) {
      const exists = await this.get(workspaceId, id);
      if (!exists) throw new DataLayerError("Model not found in workspace", "MODEL_NOT_FOUND");
    }

    await this.db.update(workspaces).set({ defaultModelId: id ?? null }).where(eq(workspaces.id, workspaceId));
  }

  async getWorkspaceDefault(workspaceId: string): Promise<Model | null> {
    const workspace = await this.db.query.workspaces.findFirst({
      columns: { defaultModelId: true },
      where: eq(workspaces.id, workspaceId),
    });
    if (!workspace?.defaultModelId) return null;
    return this.get(workspaceId, workspace.defaultModelId);
  }

  async countActiveSessionReferences(workspaceId: string, id: string): Promise<number> {
    const result = await this.db
      .select({ value: count() })
      .from(sessions)
      .where(
        and(
          eq(sessions.workspaceId, workspaceId),
          eq(sessions.modelId, id),
          notInArray(sessions.status, ["closed", "expired", "error"])
        )
      );

    return result[0]?.value ?? 0;
  }

  private selectBase() {
    return this.db
      .select({
        id: models.id,
        workspaceId: models.workspaceId,
        providerId: models.providerId,
        displayName: models.displayName,
        provider: providers.provider,
        providerDisplayName: providers.displayName,
        modelName: models.modelName,
        secretRefsJson: providers.secretRefsJson,
        providerConfigJson: providers.configJson,
        configJson: models.configJson,
        createdAt: models.createdAt,
        updatedAt: models.updatedAt,
        deletedAt: models.deletedAt,
      })
      .from(models)
      .innerJoin(providers, eq(models.providerId, providers.id));
  }
}
