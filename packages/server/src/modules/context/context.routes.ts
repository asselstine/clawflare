import { Hono } from "hono";
import type { AppBindings } from "../../http/app-bindings.js";
import { requireAuth } from "../../middleware/auth.js";
import type { Env } from "../../internal-types/index.js";
import type { AgentSession } from "../../types.js";
import { json } from "../../http/responses.js";
import type { RequestContext } from "../../http/request-context.js";
import { logger } from "../../lib/logger.js";

export const contextRoutes = new Hono<AppBindings>();

contextRoutes.use("*", requireAuth);
contextRoutes.get("/", (c) =>
  handleGetContext(c.req.raw, c.env, c.get("requestContext")!)
);
contextRoutes.post("/", (c) =>
  handleNewContext(c.req.raw, c.env, c.get("requestContext")!)
);

// Context Route Handler - /v1/context
// Legacy compatibility endpoints

/**
 * Get context - legacy compatibility endpoint
 * Returns a minimal context object
 */
export async function handleGetContext(
  _request: Request,
  _env: Env,
  requestContext: RequestContext
): Promise<Response> {
  try {
    // Minimal implementation - includes workspace context
    const context: AgentSession = {
      id: "main",
      messages: [],
      createdAt: Date.now(),
    };

    return json({
      ...context,
      workspaceId: requestContext.workspace.id,
      workspaceName: requestContext.workspace.name,
    });
  } catch (error) {
    logger.error("Get context failed", error, {
      handler: "handleGetContext",
      route: "GET /v1/context",
      workspaceId: requestContext.workspace.id,
    });
    return json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}

/**
 * Create new context - legacy compatibility endpoint
 * Returns a new context object
 */
export async function handleNewContext(
  request: Request,
  _env: Env,
  requestContext: RequestContext
): Promise<Response> {
  try {
    const body = (await request.json()) as { parentId?: string };
    const sessionId = crypto.randomUUID();

    const context: AgentSession = {
      id: sessionId,
      parentId: body.parentId,
      messages: [],
      createdAt: Date.now(),
    };

    return json({
      ...context,
      workspaceId: requestContext.workspace.id,
      workspaceName: requestContext.workspace.name,
    });
  } catch (error) {
    logger.error("New context failed", error, {
      handler: "handleNewContext",
      route: "POST /v1/context",
      workspaceId: requestContext.workspace.id,
    });
    return json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
