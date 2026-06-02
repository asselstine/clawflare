import { Hono } from "hono";
import type { AppBindings } from "../../http/app-bindings.js";
import { EgressHandlerRepository } from "../../data/index.js";
import type { Env } from "../../internal-types/index.js";
import { badRequest, json, notFound, serverError } from "../../http/responses.js";
import type { RequestContext } from "../../http/request-context.js";
import { requireAuth } from "../../middleware/auth.js";
import { logger } from "../../lib/logger.js";
import type { AuthSession } from "../secrets/index.js";
import {
  configureEgressHandler,
  listAvailableEgressHandlers,
  redactEgressHandler,
  setEgressHandlerEnabled,
} from "./egress-handlers.service.js";

export const egressHandlersRoutes = new Hono<AppBindings>();

egressHandlersRoutes.use("*", requireAuth);
egressHandlersRoutes.get("/available", (_c) =>
  handleListAvailableEgressHandlers()
);
egressHandlersRoutes.get("/", (c) =>
  handleListEgressHandlers(c.env, new URL(c.req.url), c.get("requestContext")!)
);
egressHandlersRoutes.post("/", (c) =>
  handleConfigureEgressHandler(c.req.raw, c.env, c.get("requestContext")!)
);
egressHandlersRoutes.get("/:egressHandlerId", (c) =>
  handleGetEgressHandler(c.env, c.get("requestContext")!, c.req.param("egressHandlerId"))
);
egressHandlersRoutes.patch("/:egressHandlerId", (c) =>
  handleUpdateEgressHandler(c.req.raw, c.env, c.get("requestContext")!, c.req.param("egressHandlerId"))
);

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

export function handleListAvailableEgressHandlers(): Response {
  return json({ egressHandlers: listAvailableEgressHandlers() });
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
      egressHandlers: handlers.map(redactEgressHandler),
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
  egressHandlerId: string
): Promise<Response> {
  try {
    const egressHandlers = new EgressHandlerRepository(env.DB);
    const handler = await egressHandlers.get(requestContext.workspace.id, egressHandlerId);
    if (!handler) {
      return notFound("Egress handler");
    }

    return json({
      egressHandler: redactEgressHandler(handler),
    });
  } catch (error) {
    logger.error("Get egress handler failed", error, {
      handler: "handleGetEgressHandler",
      route: "GET /v1/egress-handlers/:egressHandlerId",
      egressHandlerId,
      workspaceId: requestContext.workspace.id,
    });
    return serverError(error instanceof Error ? error.message : "Unknown error");
  }
}

interface ConfigureEgressHandlerRequest {
  egressHandlerId?: string;
  secrets?: Record<string, string>;
  config?: Record<string, unknown>;
  enabled?: boolean;
}

export async function handleConfigureEgressHandler(
  request: Request,
  env: Env,
  requestContext: RequestContext
): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as ConfigureEgressHandlerRequest;
  const egressHandlerId = body.egressHandlerId;
  if (!egressHandlerId || typeof egressHandlerId !== "string") {
    return badRequest("egressHandlerId is required");
  }

  try {
    const handler = await configureEgressHandler(
      env,
      requestContext.workspace.id,
      createAuthSession(requestContext),
      {
        egressHandlerId,
        secrets: body.secrets,
        config: body.config,
        enabled: body.enabled,
      }
    );
    return json({ egressHandler: redactEgressHandler(handler) }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("Configure egress handler failed", error, {
      handler: "handleConfigureEgressHandler",
      route: "POST /v1/egress-handlers",
      workspaceId: requestContext.workspace.id,
    });
    return badRequest(message);
  }
}

interface UpdateEgressHandlerRequest {
  secrets?: Record<string, string>;
  config?: Record<string, unknown>;
  enabled?: boolean;
}

export async function handleUpdateEgressHandler(
  request: Request,
  env: Env,
  requestContext: RequestContext,
  egressHandlerId: string
): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as UpdateEgressHandlerRequest;

  try {
    const handler =
      body.secrets || body.config
        ? await configureEgressHandler(
            env,
            requestContext.workspace.id,
            createAuthSession(requestContext),
            {
              egressHandlerId,
              secrets: body.secrets,
              config: body.config,
              enabled: body.enabled,
            }
          )
        : await setEgressHandlerEnabled(
            env,
            requestContext.workspace.id,
            egressHandlerId,
            body.enabled ?? true
          );

    return json({ egressHandler: redactEgressHandler(handler) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("Unknown egress handler")) {
      return notFound("Egress handler");
    }
    logger.error("Update egress handler failed", error, {
      handler: "handleUpdateEgressHandler",
      route: "PATCH /v1/egress-handlers/:egressHandlerId",
      egressHandlerId,
      workspaceId: requestContext.workspace.id,
    });
    return badRequest(message);
  }
}
