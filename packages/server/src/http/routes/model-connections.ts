// Model Connections HTTP Routes
// RESTful API for workspace-scoped AI model connections

import type { Env } from "../../internal-types/index.js";
import type { RequestContext } from "../request-context.js";
import { json, badRequest, notFound, forbidden } from "../responses.js";
import { hasPermission } from "../request-context.js";
import type { PublicModelConnection } from "../../model-providers.js";
import {
  createModelConnection,
  updateModelConnection,
  deleteModelConnection,
  resolveModelConnection,
  listModelConnections,
  getWorkspaceDefaultModelConnection,
  setWorkspaceDefaultModelConnection,
} from "../../model-connection-service.js";

// =============================================================================
// Response Types
// =============================================================================

interface ModelConnectionListResponse {
  modelConnections: PublicModelConnection[];
  defaultModelConnectionId?: string;
}

interface ModelConnectionResponse {
  modelConnection: PublicModelConnection;
}

// =============================================================================
// List Model Connections
// =============================================================================

export async function handleListModelConnections(
  _request: Request,
  env: Env,
  requestContext: RequestContext
): Promise<Response> {
  const workspaceId = requestContext.workspace.id;

  const [connections, defaultConnection] = await Promise.all([
    listModelConnections(env, workspaceId),
    getWorkspaceDefaultModelConnection(env, workspaceId),
  ]);

  const response: ModelConnectionListResponse = {
    modelConnections: connections,
    defaultModelConnectionId: defaultConnection?.id,
  };

  return json(response);
}

// =============================================================================
// Create Model Connection
// =============================================================================

interface CreateModelConnectionRequest {
  displayName?: string;
  provider: string;
  modelName: string;
  secrets: Record<string, string>;
  config?: Record<string, unknown>;
  setAsDefault?: boolean;
}

export async function handleCreateModelConnection(
  request: Request,
  env: Env,
  requestContext: RequestContext
): Promise<Response> {
  // Require admin or owner role
  if (!hasPermission(requestContext, "admin")) {
    return forbidden("Admin permission required to create model connections");
  }

  const body = (await request.json().catch(() => ({}))) as CreateModelConnectionRequest;

  // Validate required fields
  if (!body.provider || typeof body.provider !== "string") {
    return badRequest("provider is required");
  }

  if (!body.modelName || typeof body.modelName !== "string") {
    return badRequest("modelName is required");
  }

  if (!body.secrets || typeof body.secrets !== "object") {
    return badRequest("secrets object is required");
  }

  try {
    const result = await createModelConnection(env, requestContext.workspace.id, {
      displayName: body.displayName,
      provider: body.provider,
      modelName: body.modelName,
      secrets: body.secrets,
      config: body.config,
      setAsDefault: body.setAsDefault,
    });

    const response: ModelConnectionResponse = {
      modelConnection: {
        id: result.connection.id,
        workspaceId: result.connection.workspaceId,
        displayName: result.connection.displayName,
        provider: result.connection.provider,
        modelName: result.connection.modelName,
        configuredSecrets: result.secretsStored,
        requiredSecrets: [], // Populated by redactModelConnection
        createdAt: result.connection.createdAt,
        updatedAt: result.connection.updatedAt,
      },
    };

    // Apply redaction to include requiredSecrets
    const { redactModelConnection } = await import("../../model-providers.js");
    response.modelConnection = redactModelConnection(result.connection);

    return json(response, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return badRequest(message);
  }
}

// =============================================================================
// Get Single Model Connection
// =============================================================================

export async function handleGetModelConnection(
  _request: Request,
  env: Env,
  requestContext: RequestContext,
  id: string
): Promise<Response> {
  try {
    const connection = await resolveModelConnection(env, requestContext.workspace.id, id);
    if (!connection) {
      return notFound("Model connection");
    }

    // TODO: Return public/redacted version
    // For now, return minimal info
    return json({
      id: connection.id,
      provider: connection.provider,
      modelName: connection.modelName,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("not found")) {
      return notFound("Model connection");
    }
    return badRequest(message);
  }
}

// =============================================================================
// Update Model Connection
// =============================================================================

interface UpdateModelConnectionRequest {
  displayName?: string | null;
  provider?: string;
  modelName?: string;
  secrets?: Record<string, string>;
  config?: Record<string, unknown>;
}

export async function handleUpdateModelConnection(
  request: Request,
  env: Env,
  requestContext: RequestContext,
  id: string
): Promise<Response> {
  // Require admin or owner role
  if (!hasPermission(requestContext, "admin")) {
    return forbidden("Admin permission required to update model connections");
  }

  const body = (await request.json().catch(() => ({}))) as UpdateModelConnectionRequest;

  try {
    const result = await updateModelConnection(env, requestContext.workspace.id, id, {
      displayName: body.displayName,
      provider: body.provider,
      modelName: body.modelName,
      secrets: body.secrets,
      config: body.config,
    });

    const { redactModelConnection } = await import("../../model-providers.js");
    const response: ModelConnectionResponse = {
      modelConnection: redactModelConnection(result),
    };

    return json(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("not found")) {
      return notFound("Model connection");
    }
    return badRequest(message);
  }
}

// =============================================================================
// Delete Model Connection
// =============================================================================

export async function handleDeleteModelConnection(
  _request: Request,
  env: Env,
  requestContext: RequestContext,
  id: string
): Promise<Response> {
  // Require admin or owner role
  if (!hasPermission(requestContext, "admin")) {
    return forbidden("Admin permission required to delete model connections");
  }

  try {
    await deleteModelConnection(env, requestContext.workspace.id, id);
    return json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("not found")) {
      return notFound("Model connection");
    }
    if (message.includes("active session")) {
      return badRequest(message);
    }
    return badRequest(message);
  }
}

// =============================================================================
// Set Workspace Default
// =============================================================================

interface SetDefaultRequest {
  modelConnectionId: string | null;
}

export async function handleSetDefaultModelConnection(
  request: Request,
  env: Env,
  requestContext: RequestContext
): Promise<Response> {
  // Require admin or owner role
  if (!hasPermission(requestContext, "admin")) {
    return forbidden("Admin permission required to set default model connection");
  }

  const body = (await request.json().catch(() => ({}))) as SetDefaultRequest;

  try {
    await setWorkspaceDefaultModelConnection(
      env,
      requestContext.workspace.id,
      body.modelConnectionId ?? null
    );

    return json({
      ok: true,
      defaultModelConnectionId: body.modelConnectionId ?? undefined,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("not found")) {
      return notFound("Model connection");
    }
    return badRequest(message);
  }
}
