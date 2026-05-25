// Debug Route Handler - /v1/cf_debug
// Inspect session details from D1

import type { Env } from "../../internal-types/index.js";
import { json, badRequest, notFound, serverError, forbidden } from "../responses.js";
import { getDataLayer } from "../../data/index.js";
import type { RequestContext } from "../request-context.js";

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

    const dataLayer = getDataLayer(env);

    // Get session metadata scoped to workspace
    const session = await dataLayer.sessions.findByIdInWorkspace(
      requestContext.workspace.id,
      sessionId
    );
    if (!session) {
      return notFound("Session");
    }

    // Get actual event count and recent events
    const eventCount = await dataLayer.events.count(sessionId);
    const recentEvents = await dataLayer.events.listRecent(sessionId, 20);

    // Get queue depth
    const queueStatus = await dataLayer.inputQueue.status(sessionId);

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
    return serverError(error instanceof Error ? error.message : "Unknown error");
  }
}
