import { Hono } from "hono";
import type { AppBindings } from "../../http/app-bindings.js";
import { requireAuth } from "../../middleware/auth.js";
import type { Env } from "../../internal-types/index.js";
import type { RequestContext } from "../../http/request-context.js";
import { SessionRepository } from "../../data/index.js";
import { invokeTool, listBuiltinTools, listToolGroups } from "./tools.service.js";
import { badRequest, json, notFound } from "../../http/responses.js";
import { logger } from "../../lib/logger.js";

export const toolsRoutes = new Hono<AppBindings>();

toolsRoutes.use("*", requireAuth);
toolsRoutes.get("/", () => handleListTools());
toolsRoutes.post("/:name", (c) =>
  handleInvokeTool(
    c.req.raw,
    c.env,
    c.executionCtx,
    c.get("requestContext")!,
    c.req.param("name")
  )
);

// Tools Route Handler - /v1/tools
// Lists available agent tools

/**
 * List available tools
 */
export function handleListTools(): Response {
  return json({
    groups: listToolGroups(),
    tools: listBuiltinTools(),
  });
}

export async function handleInvokeTool(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  requestContext: RequestContext,
  name: string
): Promise<Response> {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      input?: unknown;
      sessionId?: string;
    };
    if (!body.sessionId) {
      return badRequest("Tool execution requires a session");
    }
    const sessions = new SessionRepository(env.DB);
    const session = await sessions.findByIdInWorkspace(requestContext.workspace.id, body.sessionId);
    if (!session) {
      return notFound("Session");
    }

    const result = await invokeTool({
      env,
      ctx,
      name,
      input: body.input ?? {},
      toolCtx: {
        workspaceId: requestContext.workspace.id,
        sessionId: body.sessionId,
      },
    });

    return json({ tool: name, result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("Tool not found:")) {
      return notFound("Tool");
    }
    logger.error("Invoke tool failed", error, {
      handler: "handleInvokeTool",
      route: "POST /v1/tools/:name",
      tool: name,
      workspaceId: requestContext.workspace.id,
    });
    return badRequest(message);
  }
}
