import { Hono } from "hono";
import type { AppBindings } from "../../http/app-bindings.js";
import { EgressHandlerRepository } from "../../data/index.js";
import type { EgressHandlerMetadata } from "../../data/index.js";
import type { Env } from "../../internal-types/index.js";
import { json, notFound, serverError } from "../../http/responses.js";
import type { RequestContext } from "../../http/request-context.js";
import { requireAuth } from "../../middleware/auth.js";
import { logger } from "../../lib/logger.js";

export const egressHandlersRoutes = new Hono<AppBindings>();

egressHandlersRoutes.use("*", requireAuth);
egressHandlersRoutes.get("/", (c) =>
  handleListEgressHandlers(c.env, new URL(c.req.url), c.get("requestContext")!)
);
egressHandlersRoutes.get("/:name", (c) =>
  handleGetEgressHandler(c.env, c.get("requestContext")!, c.req.param("name"))
);

interface PublicEgressHandler {
  name: string;
  description: string;
  domains: string[];
  enabled: boolean;
  updatedAt: number;
}

function toPublicEgressHandler(
  handler: EgressHandlerMetadata
): PublicEgressHandler {
  return {
    name: handler.name,
    description: handler.description,
    domains: handler.domains,
    enabled: handler.enabled,
    updatedAt: handler.updatedAt,
  };
}

export async function handleListEgressHandlers(
  env: Env,
  url: URL,
  requestContext: RequestContext
): Promise<Response> {
  try {
    const query = url.searchParams.get("q");
    const enabledOnly = url.searchParams.get("enabledOnly") !== "false";
    const limit = Math.min(
      Number.parseInt(url.searchParams.get("limit") ?? "20", 10) || 20,
      100
    );

    const egressHandlers = new EgressHandlerRepository(env.DB);
    const handlers = query
      ? await egressHandlers.search(requestContext.workspace.id, query, limit)
      : (await egressHandlers.list(requestContext.workspace.id, enabledOnly)).slice(
          0,
          limit
        );

    return json({
      egressHandlers: handlers.map(toPublicEgressHandler),
    });
  } catch (error) {
    logger.error("List egress handlers failed", error, {
      handler: "handleListEgressHandlers",
      route: "GET /v1/egress-handlers",
      workspaceId: requestContext.workspace.id,
    });
    return serverError(error instanceof Error ? error.message : "Unknown error");
  }
}

export async function handleGetEgressHandler(
  env: Env,
  requestContext: RequestContext,
  name: string
): Promise<Response> {
  try {
    const egressHandlers = new EgressHandlerRepository(env.DB);
    const handler = await egressHandlers.get(requestContext.workspace.id, name);
    if (!handler) {
      return notFound("Egress handler");
    }

    return json({
      egressHandler: toPublicEgressHandler(handler),
    });
  } catch (error) {
    logger.error("Get egress handler failed", error, {
      handler: "handleGetEgressHandler",
      route: "GET /v1/egress-handlers/:name",
      name,
      workspaceId: requestContext.workspace.id,
    });
    return serverError(error instanceof Error ? error.message : "Unknown error");
  }
}
