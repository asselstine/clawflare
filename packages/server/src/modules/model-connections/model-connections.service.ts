// Model Connection Service
// Coordinates D1 persistence and Secret Store for AI model connections

import type { Env } from "../../internal-types/index.js";
import {
  ModelConnectionRepository,
  SessionRepository,
  type ModelConnection,
} from "../../data/index.js";
import { getSecretStore, type AuthSession } from "../../data/secrets/index.js";
import {
  requiredSecretsForProvider,
  defaultModelForProvider,
} from "../providers/providers.catalog.js";
import {
  validateModelConnectionInput,
  redactModelConnection,
  type PublicModelConnection,
} from "./model-connections.validation.js";

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
  auth: AuthSession,
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

  const modelConnections = new ModelConnectionRepository(env.DB);
  const secretStore = getSecretStore(env);

  // Create D1 record first
  const connection = await modelConnections.create({
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
      const ref = await secretStore.putModelConnectionSecret(auth, {
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
  const updatedConnection = await modelConnections.update(
    workspaceId,
    connection.id,
    {
      secretRefs,
    }
  );

  // Set as default if requested
  if (input.setAsDefault) {
    await modelConnections.setWorkspaceDefault(workspaceId, connection.id);
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
  auth: AuthSession,
  input: {
    displayName?: string | null;
    provider?: string;
    modelName?: string;
    secrets?: Record<string, string>;
    config?: Record<string, unknown>;
  }
): Promise<ModelConnection> {
  const modelConnections = new ModelConnectionRepository(env.DB);
  const secretStore = getSecretStore(env);

  // Get existing connection
  const existing = await modelConnections.get(workspaceId, id);
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
        const ref = await secretStore.putModelConnectionSecret(auth, {
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
  return await modelConnections.update(workspaceId, id, {
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
  id: string,
  auth: AuthSession
): Promise<void> {
  const modelConnections = new ModelConnectionRepository(env.DB);
  const secretStore = getSecretStore(env);

  // Get connection to find secret refs
  const connection = await modelConnections.get(workspaceId, id);
  if (!connection) {
    throw new Error("Model connection not found");
  }

  // Delete secrets from Secret Store
  const deleteErrors: string[] = [];
  for (const ref of Object.values(connection.secretRefs)) {
    try {
      await secretStore.deleteModelConnectionSecret(auth, ref);
    } catch (error) {
      deleteErrors.push(error instanceof Error ? error.message : String(error));
    }
  }

  // Soft-delete the connection in D1
  // If secret deletion fails, we still mark D1 as deleted
  // to prevent further use, but the secrets remain in Secret Store
  try {
    await modelConnections.softDelete(workspaceId, id);
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
      "[deleteModelConnection] Failed to delete some secrets:",
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
  connectionId: string,
  auth: AuthSession
): Promise<ResolvedModelConnection> {
  const modelConnections = new ModelConnectionRepository(env.DB);
  const secretStore = getSecretStore(env);

  const connection = await modelConnections.get(workspaceId, connectionId);
  if (!connection) {
    throw new Error("Model connection not found");
  }

  // Load secrets
  const requiredSecrets = requiredSecretsForProvider(connection.provider);
  const secrets: Record<string, string> = {};

  for (const key of requiredSecrets) {
    const ref = connection.secretRefs[key];
    if (ref) {
      const value = await secretStore.getModelConnectionSecret(auth, ref);
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
  requestedId: string | undefined,
  auth: AuthSession
): Promise<ResolvedModelConnection | null> {
  const modelConnections = new ModelConnectionRepository(env.DB);

  // Try explicit request
  if (requestedId) {
    const connection = await modelConnections.get(workspaceId, requestedId);
    if (!connection) {
      return null;
    }
    return await resolveModelConnection(env, workspaceId, requestedId, auth);
  }

  // Try workspace default
  const defaultConnection = await modelConnections.getWorkspaceDefault(
    workspaceId
  );
  if (defaultConnection) {
    return await resolveModelConnection(
      env,
      workspaceId,
      defaultConnection.id,
      auth
    );
  }

  // No env fallback - explicit model connection required
  return null;
}

/**
 * Resolve model connection for an existing session
 */
export async function resolveModelConnectionForSession(
  env: Env,
  sessionId: string,
  auth: AuthSession
): Promise<ResolvedModelConnection | null> {
  const sessions = new SessionRepository(env.DB);
  const modelConnections = new ModelConnectionRepository(env.DB);

  const session = await sessions.findById(sessionId);
  if (!session) {
    throw new Error("Session not found");
  }

  // If session has a model connection, use it
  if (session.modelConnectionId) {
    return await resolveModelConnection(
      env,
      session.workspaceId,
      session.modelConnectionId,
      auth
    );
  }

  // Fallback to workspace default
  const defaultConnection = await modelConnections.getWorkspaceDefault(
    session.workspaceId
  );
  if (defaultConnection) {
    return await resolveModelConnection(
      env,
      session.workspaceId,
      defaultConnection.id,
      auth
    );
  }

  // No env fallback - explicit model connection required
  return null;
}

/**
 * Set workspace default model connection
 * Note: This doesn't require secret access, so no auth parameter needed
 */
export async function setWorkspaceDefaultModelConnection(
  env: Env,
  workspaceId: string,
  id: string | null
): Promise<void> {
  const modelConnections = new ModelConnectionRepository(env.DB);
  await modelConnections.setWorkspaceDefault(workspaceId, id);
}

/**
 * Check if a workspace has any model connections configured
 * Note: This doesn't require secret access, so no auth parameter needed
 */
export async function hasModelConnections(
  env: Env,
  workspaceId: string
): Promise<boolean> {
  const modelConnections = new ModelConnectionRepository(env.DB);
  const connections = await modelConnections.list(workspaceId);
  return connections.length > 0;
}

/**
 * Get workspace default model connection (public/redacted)
 * Note: This doesn't require secret access, so no auth parameter needed
 */
export async function getWorkspaceDefaultModelConnection(
  env: Env,
  workspaceId: string
): Promise<PublicModelConnection | null> {
  const modelConnections = new ModelConnectionRepository(env.DB);
  const defaultConnection = await modelConnections.getWorkspaceDefault(
    workspaceId
  );
  return defaultConnection ? redactModelConnection(defaultConnection) : null;
}

/**
 * List model connections for workspace (public/redacted)
 * Note: This doesn't require secret access, so no auth parameter needed
 */
export async function listModelConnections(
  env: Env,
  workspaceId: string
): Promise<PublicModelConnection[]> {
  const modelConnections = new ModelConnectionRepository(env.DB);
  const connections = await modelConnections.list(workspaceId);
  return connections.map(redactModelConnection);
}
