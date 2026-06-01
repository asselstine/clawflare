import { Hono } from "hono";
import type { AppBindings } from "../../http/app-bindings.js";
import { requireAuth } from "../../middleware/auth.js";
import type { Env } from "../../internal-types/index.js";
import { json, badRequest, notFound, serverError } from "../../http/responses.js";
import {
  InputQueueRepository,
  SessionEventRepository,
  SessionRepository,
} from "../../data/index.js";
import type { RequestContext } from "../../http/request-context.js";
import { logger } from "../../lib/logger.js";

export const debugRoutes = new Hono<AppBindings>();

debugRoutes.use("*", requireAuth);
debugRoutes.get("/", (c) =>
  handleCfDebug(c.env, new URL(c.req.url), c.get("requestContext")!)
);

// Debug Route Handler - /v1/cf_debug
// Inspect session details from D1

/**
 * Inspect session details from D1
 */
export async function handleCfDebug(
  env: Env,
  url: URL,
  requestContext: RequestContext
): Promise<Response> {
  try {
    const sessionId = url.searchParams.get("sessionId");

    if (!sessionId) {
      return badRequest("sessionId query param required");
    }

    const sessions = new SessionRepository(env.DB);
    const events = new SessionEventRepository(env.DB);
    const inputQueue = new InputQueueRepository(env.DB);

    // Get session metadata scoped to workspace
    const session = await sessions.findByIdInWorkspace(
      requestContext.workspace.id,
      sessionId
    );
    if (!session) {
      return notFound("Session");
    }

    // Get actual event count and recent events
    const eventCount = await events.count(sessionId);
    const recentEvents = await events.listRecent(sessionId, 20);

    // Get queue depth
    const queueStatus = await inputQueue.status(sessionId);

    const debugInfo = {
      timestamp: Date.now(),
      sessionId,
      workspaceId: requestContext.workspace.id,
      session: {
        ...session,
        isActive: session.status === "idle" || session.status === "processing",
      },
      stats: {
        eventCount,
        queueDepth: queueStatus.pending,
      },
      recentEvents: recentEvents.map((e: import("../../types.js").SessionEvent) => ({
        sequence: e.sequence,
        timestamp: e.timestamp,
        type: e.type,
      })),
    };

    return json(debugInfo);
  } catch (error) {
    logger.error("Cloudflare debug route failed", error, {
      handler: "handleCfDebug",
      route: "GET /v1/cf_debug",
      sessionId: url.searchParams.get("sessionId"),
      workspaceId: requestContext.workspace.id,
    });
    return serverError(error instanceof Error ? error.message : "Unknown error");
  }
}
