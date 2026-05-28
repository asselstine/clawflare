/**
 * Model Connection Data Types
 * 
 * Domain types for model connection management.
 */

import type { ModelProvider } from "@clawflare/types";

export type { ModelProvider } from "@clawflare/types";

/**
 * Model connection entity - workspace scoped AI model configuration
 */
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

/**
 * Parameters for creating a model connection
 */
export interface CreateModelConnectionParams {
  id?: string;
  workspaceId: string;
  displayName?: string;
  provider: string;
  modelName: string;
  secretRefs?: Record<string, string>;
  config?: Record<string, unknown>;
}

/**
 * Parameters for updating a model connection
 */
export interface UpdateModelConnectionParams {
  displayName?: string | null;
  provider?: string;
  modelName?: string;
  secretRefs?: Record<string, string>;
  config?: Record<string, unknown>;
}

/**
 * Model connection repository interface
 */
export interface ModelConnectionRepository {
  /** Create a new model connection */
  create(params: CreateModelConnectionParams): Promise<ModelConnection>;

  /** Get a model connection by ID - must belong to workspace */
  get(workspaceId: string, id: string): Promise<ModelConnection | null>;

  /** List all non-deleted model connections in a workspace */
  list(workspaceId: string): Promise<ModelConnection[]>;

  /** Update a model connection */
  update(workspaceId: string, id: string, params: UpdateModelConnectionParams): Promise<ModelConnection>;

  /** Soft-delete a model connection */
  softDelete(workspaceId: string, id: string): Promise<void>;

  /** Set workspace default model connection */
  setWorkspaceDefault(workspaceId: string, id: string | null): Promise<void>;

  /** Get workspace default model connection */
  getWorkspaceDefault(workspaceId: string): Promise<ModelConnection | null>;

  /** Count active sessions referencing this model connection */
  countActiveSessionReferences(workspaceId: string, id: string): Promise<number>;
}
