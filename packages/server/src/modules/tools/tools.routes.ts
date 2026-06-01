import { Hono } from "hono";
import type { AppBindings } from "../../http/app-bindings.js";
import { requireAuth } from "../../middleware/auth.js";
import type { Env } from "../../internal-types/index.js";
import type { RequestContext } from "../../http/request-context.js";
import { createTools, invokeTool } from "./tools.service.js";
import { badRequest, json, notFound, serverError } from "../../http/responses.js";
import { logger } from "../../lib/logger.js";

export const toolsRoutes = new Hono<AppBindings>();

toolsRoutes.use("*", requireAuth);
toolsRoutes.get("/", (c) =>
  handleListTools(c.env, c.executionCtx, c.get("requestContext")!)
);
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
export async function handleListTools(
  env: Env,
  ctx: ExecutionContext,
  requestContext?: RequestContext
): Promise<Response> {
  try {
    const tools = createTools(env, ctx, {
      workspaceId: requestContext?.workspace.id,
    });
    return json({ tools });
  } catch (error) {
    logger.error("List tools failed", error, {
      handler: "handleListTools",
      route: "GET /v1/tools",
    });
    return serverError(error instanceof Error ? error.message : "Unknown error");
  }
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
