// Model Connection Service
// Coordinates D1 persistence and Secret Store for AI model connections

import type { Env } from "./internal-types/index.js";
import type { ModelConnection } from "./data/index.js";
import { getDataLayer } from "./data/index.js";
import { getSecretStore } from "./secret-store.js";
import {
  validateModelConnectionInput,
  requiredSecretsForProvider,
  defaultModelForProvider,
  redactModelConnection,
  type PublicModelConnection,
} from "./model-providers.js";

/**
 * Resolved model connection with secrets loaded
 */
export interface ResolvedModelConnection {
  id: string;
  provider: string;
  modelName: string;
  secrets: Record<string, string>;
  config: Record<string, unknown>;
}

/**
 * Model connection creation result
 */
export interface CreateModelConnectionResult {
  connection: ModelConnection;
  secretsStored: string[];
}

/**
 * Create a new model connection with secrets stored in Secret Store
 */
export async function createModelConnection(
  env: Env,
  workspaceId: string,
  input: {
    displayName?: string;
    provider: string;
    modelName: string;
    secrets: Record<string, string>;
    config?: Record<string, unknown>;
    setAsDefault?: boolean;
  }
): Promise<CreateModelConnectionResult> {
  // Validate provider and secrets
  const validation = validateModelConnectionInput({
    provider: input.provider,
    modelName: input.modelName,
    secrets: input.secrets,
    config: input.config,
  });

  if (!validation.ok) {
    throw new Error(validation.error);
  }

  if (validation.result.missingSecrets.length > 0) {
    throw new Error(
      `Missing required secrets: ${validation.result.missingSecrets.join(", ")}`
    );
  }

  const data = getDataLayer(env);
  const secretStore = getSecretStore(env);

  // Create D1 record first
  const connection = await data.modelConnections.create({
    workspaceId,
    displayName: input.displayName,
    provider: input.provider,
    modelName: input.modelName,
    config: input.config,
  });

  // Store secrets in Secret Store
  const secretRefs: Record<string, string> = {};
  const secretsStored: string[] = [];

  for (const [key, value] of Object.entries(input.secrets)) {
    if (value) {
      const ref = await secretStore.putModelConnectionSecret({
        workspaceId,
        connectionId: connection.id,
        key,
        value,
      });
      secretRefs[key] = ref;
      secretsStored.push(key);
    }
  }

  // Update connection with secret refs
  const updatedConnection = await data.modelConnections.update(workspaceId, connection.id, {
    secretRefs,
  });

  // Set as default if requested
  if (input.setAsDefault) {
    await data.modelConnections.setWorkspaceDefault(workspaceId, connection.id);
  }

  return {
    connection: updatedConnection,
    secretsStored,
  };
}

/**
 * Update a model connection, rotating secrets as needed
 */
export async function updateModelConnection(
  env: Env,
  workspaceId: string,
  id: string,
  input: {
    displayName?: string | null;
    provider?: string;
    modelName?: string;
    secrets?: Record<string, string>;
    config?: Record<string, unknown>;
  }
): Promise<ModelConnection> {
  const data = getDataLayer(env);
  const secretStore = getSecretStore(env);

  // Get existing connection
  const existing = await data.modelConnections.get(workspaceId, id);
  if (!existing) {
    throw new Error("Model connection not found");
  }

  // Update secrets if provided
  let secretRefs = { ...existing.secretRefs };
  if (input.secrets && Object.keys(input.secrets).length > 0) {
    // Update provider if changed
    const provider = input.provider ?? existing.provider;
    const requiredSecrets = requiredSecretsForProvider(provider);

    // Validate all required secrets are present
    for (const key of requiredSecrets) {
      if (!(key in input.secrets) && !secretRefs[key]) {
        throw new Error(`Missing required secret: ${key}`);
      }
    }

    // Store new secrets
    for (const [key, value] of Object.entries(input.secrets)) {
      if (value) {
        const ref = await secretStore.putModelConnectionSecret({
          workspaceId,
          connectionId: id,
          key,
          value,
        });
        secretRefs[key] = ref;
      }
    }
  }

  // Update model name (use default if provider changed and no model specified)
  let modelName = input.modelName ?? existing.modelName;
  if (input.provider && input.provider !== existing.provider && !input.modelName) {
    const defaultModel = defaultModelForProvider(input.provider);
    if (defaultModel) {
      modelName = defaultModel;
    }
  }

  // Update connection in D1
  return await data.modelConnections.update(workspaceId, id, {
    displayName: input.displayName,
    provider: input.provider,
    modelName,
    secretRefs,
    config: input.config,
  });
}

/**
 * Delete a model connection and its secrets
 */
export async function deleteModelConnection(
  env: Env,
  workspaceId: string,
  id: string
): Promise<void> {
  const data = getDataLayer(env);
  const secretStore = getSecretStore(env);

  // Get connection to find secret refs
  const connection = await data.modelConnections.get(workspaceId, id);
  if (!connection) {
    throw new Error("Model connection not found");
  }

  // Delete secrets from Secret Store
  const deleteErrors: string[] = [];
  for (const ref of Object.values(connection.secretRefs)) {
    try {
      await secretStore.deleteModelConnectionSecret(ref);
    } catch (error) {
      deleteErrors.push(
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  // Soft-delete the connection in D1
  // If secret deletion fails, we still mark D1 as deleted
  // to prevent further use, but the secrets remain in Secret Store
  try {
    await data.modelConnections.softDelete(workspaceId, id);
  } catch (error) {
    throw new Error(
      `Failed to delete model connection: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  // If there were secret deletion errors, we might want to log them
  // but not fail the operation since D1 is already soft-deleted
  if (deleteErrors.length > 0) {
    console.warn(
      `[deleteModelConnection] Failed to delete some secrets:`,
      deleteErrors
    );
  }
}

/**
 * Resolve a model connection for use in a session
 * Loads secrets from Secret Store
 */
export async function resolveModelConnection(
  env: Env,
  workspaceId: string,
  connectionId: string
): Promise<ResolvedModelConnection> {
  const data = getDataLayer(env);
  const secretStore = getSecretStore(env);

  const connection = await data.modelConnections.get(workspaceId, connectionId);
  if (!connection) {
    throw new Error("Model connection not found");
  }

  // Load secrets
  const requiredSecrets = requiredSecretsForProvider(connection.provider);
  const secrets: Record<string, string> = {};

  for (const key of requiredSecrets) {
    const ref = connection.secretRefs[key];
    if (ref) {
      const value = await secretStore.getModelConnectionSecret(ref);
      if (value) {
        secrets[key] = value;
      }
    }
  }

  return {
    id: connection.id,
    provider: connection.provider,
    modelName: connection.modelName,
    secrets,
    config: connection.config,
  };
}

/**
 * Resolve model for a new session
 * Uses explicit connection ID or workspace default
 * NO env fallback - model connections must be explicitly configured
 */
export async function resolveModelConnectionForNewSession(
  env: Env,
  workspaceId: string,
  requestedId?: string
): Promise<ResolvedModelConnection | null> {
  const data = getDataLayer(env);

  // Try explicit request
  if (requestedId) {
    return await resolveModelConnection(env, workspaceId, requestedId);
  }

  // Try workspace default
  const defaultConnection = await data.modelConnections.getWorkspaceDefault(workspaceId);
  if (defaultConnection) {
    return await resolveModelConnection(env, workspaceId, defaultConnection.id);
  }

  // No env fallback - explicit model connection required
  return null;
}

/**
 * Resolve model connection for an existing session
 */
export async function resolveModelConnectionForSession(
  env: Env,
  sessionId: string
): Promise<ResolvedModelConnection | null> {
  const data = getDataLayer(env);

  const session = await data.sessions.findById(sessionId);
  if (!session) {
    throw new Error("Session not found");
  }

  // If session has a model connection, use it
  if (session.modelConnectionId) {
    return await resolveModelConnection(env, session.workspaceId, session.modelConnectionId);
  }

  // Fallback to workspace default
  const defaultConnection = await data.modelConnections.getWorkspaceDefault(session.workspaceId);
  if (defaultConnection) {
    return await resolveModelConnection(env, session.workspaceId, defaultConnection.id);
  }

  // No env fallback - explicit model connection required
  return null;
}

/**
 * Set workspace default model connection
 */
export async function setWorkspaceDefaultModelConnection(
  env: Env,
  workspaceId: string,
  id: string | null
): Promise<void> {
  const data = getDataLayer(env);
  await data.modelConnections.setWorkspaceDefault(workspaceId, id);
}

/**
 * Check if a workspace has any model connections configured
 */
export async function hasModelConnections(
  env: Env,
  workspaceId: string
): Promise<boolean> {
  const data = getDataLayer(env);
  const connections = await data.modelConnections.list(workspaceId);
  return connections.length > 0;
}

/**
 * Get workspace default model connection (public/redacted)
 */
export async function getWorkspaceDefaultModelConnection(
  env: Env,
  workspaceId: string
): Promise<PublicModelConnection | null> {
  const data = getDataLayer(env);
  const defaultConnection = await data.modelConnections.getWorkspaceDefault(workspaceId);
  return defaultConnection ? redactModelConnection(defaultConnection) : null;
}

/**
 * List model connections for workspace (public/redacted)
 */
export async function listModelConnections(
  env: Env,
  workspaceId: string
): Promise<PublicModelConnection[]> {
  const data = getDataLayer(env);
  const connections = await data.modelConnections.list(workspaceId);
  return connections.map(redactModelConnection);
}
