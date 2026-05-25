// Context Route Handler - /v1/context
// Legacy compatibility endpoints

import type { Env } from "../../internal-types/index.js";
import type { AgentSession } from "../../types.js";
import { json } from "../responses.js";
import type { RequestContext } from "../request-context.js";

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
    console.error("[handleGetContext] Error:", error);
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
    return json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
