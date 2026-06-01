import { Hono } from "hono";
import type { AppBindings } from "../../http/app-bindings.js";
import { requireAuth } from "../../middleware/auth.js";
import type { Env } from "../../internal-types/index.js";
import type { RequestContext } from "../../http/request-context.js";
import { json, badRequest, notFound } from "../../http/responses.js";
import {
  redactModelConnection,
  type PublicModelConnection,
} from "./model-connections.validation.js";
import {
  createModelConnection,
  updateModelConnection,
  deleteModelConnection,
  resolveModelConnection,
  listModelConnections,
  getWorkspaceDefaultModelConnection,
  setWorkspaceDefaultModelConnection,
} from "./model-connections.service.js";
import type { AuthSession } from "../../data/secrets/index.js";
import { logger } from "../../lib/logger.js";

export const modelConnectionsRoutes = new Hono<AppBindings>();
export const workspaceRoutes = new Hono<AppBindings>();

modelConnectionsRoutes.use("*", requireAuth);
modelConnectionsRoutes.get("/", (c) =>
  handleListModelConnections(c.req.raw, c.env, c.get("requestContext")!)
);
modelConnectionsRoutes.post("/", (c) =>
  handleCreateModelConnection(c.req.raw, c.env, c.get("requestContext")!)
);
modelConnectionsRoutes.get("/:id", (c) =>
  handleGetModelConnection(c.req.raw, c.env, c.get("requestContext")!, c.req.param("id"))
);
modelConnectionsRoutes.patch("/:id", (c) =>
  handleUpdateModelConnection(c.req.raw, c.env, c.get("requestContext")!, c.req.param("id"))
);
modelConnectionsRoutes.delete("/:id", (c) =>
  handleDeleteModelConnection(c.req.raw, c.env, c.get("requestContext")!, c.req.param("id"))
);

workspaceRoutes.use("*", requireAuth);
workspaceRoutes.put("/default-model-connection", (c) =>
  handleSetDefaultModelConnection(c.req.raw, c.env, c.get("requestContext")!)
);

// Model Connections HTTP Routes
// RESTful API for workspace-scoped AI model connections

// =============================================================================
// Helpers
// =============================================================================

/**
 * Create an immediate authorization context from the request context
 */
function createAuthSession(ctx: RequestContext): AuthSession {
  return {
    type: "immediate",
    context: {
      userId: ctx.user.id,
      workspaceId: ctx.workspace.id,
      authTime: Date.now(),
      requestId: crypto.randomUUID(),
      version: 1,
    },
  };
}

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
  // Any authenticated user can create model connections for their workspace
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

  // Create authorization context for this request
  const auth = createAuthSession(requestContext);

  try {
    const result = await createModelConnection(
      env,
      requestContext.workspace.id,
      auth,
      {
        displayName: body.displayName,
        provider: body.provider,
        modelName: body.modelName,
        secrets: body.secrets,
        config: body.config,
        setAsDefault: body.setAsDefault,
      }
    );

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

    response.modelConnection = redactModelConnection(result.connection);

    return json(response, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("Model connection creation failed", error, {
      handler: "handleCreateModelConnection",
      route: "POST /v1/model-connections",
      workspaceId: requestContext.workspace.id,
    });
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
  // Create authorization context for this request
  const auth = createAuthSession(requestContext);

  try {
    const connection = await resolveModelConnection(
      env,
      requestContext.workspace.id,
      id,
      auth
    );
    if (!connection) {
      return notFound("Model connection");
    }

    // Return redacted version without secret values
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
    logger.error("Model connection get failed", error, {
      handler: "handleGetModelConnection",
      route: "GET /v1/model-connections/:id",
      id,
      workspaceId: requestContext.workspace.id,
    });
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
  // Any authenticated user can update model connections for their workspace
  const body = (await request.json().catch(() => ({}))) as UpdateModelConnectionRequest;

  // Create authorization context for this request
  const auth = createAuthSession(requestContext);

  try {
    const result = await updateModelConnection(
      env,
      requestContext.workspace.id,
      id,
      auth,
      {
        displayName: body.displayName,
        provider: body.provider,
        modelName: body.modelName,
        secrets: body.secrets,
        config: body.config,
      }
    );

    const response: ModelConnectionResponse = {
      modelConnection: redactModelConnection(result),
    };

    return json(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("not found")) {
      return notFound("Model connection");
    }
    logger.error("Model connection update failed", error, {
      handler: "handleUpdateModelConnection",
      route: "PATCH /v1/model-connections/:id",
      id,
      workspaceId: requestContext.workspace.id,
    });
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
  // Any authenticated user can delete model connections for their workspace
  // Create authorization context for this request
  const auth = createAuthSession(requestContext);

  try {
    await deleteModelConnection(env, requestContext.workspace.id, id, auth);
    return json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("not found")) {
      return notFound("Model connection");
    }
    if (message.includes("active session")) {
      return badRequest(message);
    }
    logger.error("Model connection delete failed", error, {
      handler: "handleDeleteModelConnection",
      route: "DELETE /v1/model-connections/:id",
      id,
      workspaceId: requestContext.workspace.id,
    });
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
  // Any authenticated user can set the workspace default model connection
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
    logger.error("Set default model connection failed", error, {
      handler: "handleSetDefaultModelConnection",
      route: "POST /v1/model-connections/default",
      workspaceId: requestContext.workspace.id,
    });
    return badRequest(message);
  }
}
