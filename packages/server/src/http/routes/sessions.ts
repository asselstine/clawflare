// Sessions Route Handler - /v1/session/* and /v1/sessions
// Handles session polling, closing, and listing

import type { SessionInputEvent, SessionMetadataState, SessionListFilter } from "../../data/index.js";
import type { SessionResponse, SessionListResponse, SessionSummary, SessionStatus } from "../../types.js";
import { json, notFound, badRequest, serverError } from "../responses.js";
import { timingStart, logTiming } from "../../diagnostics.js";
import { getDataLayer } from "../../data/index.js";
import type { Env } from "../../internal-types/index.js";
import type { RequestContext } from "../request-context.js";
import { logger } from "../../logger.js";

const PROCESSING_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Get session state - polls for messages and events
 */
export async function handleGetSession(
  sessionId: string,
  url: URL,
  env: Env,
  requestContext: RequestContext
): Promise<Response> {
  const pollStart = timingStart();
  const data = getDataLayer(env);
  // Use workspace from request context
  const effectiveWorkspaceId = requestContext.workspace.id;

  try {
    // Find session scoped to workspace
    const sessionState = await data.sessions.findByIdInWorkspace(effectiveWorkspaceId, sessionId);

    if (!sessionState) {
      logTiming(env, sessionId, "session.poll.not_found", pollStart);
      return notFound("Session");
    }

    // Check for stuck workflows (auto-recovery)
    if (sessionState.status === "processing" &&
        Date.now() - sessionState.updatedAt > PROCESSING_TIMEOUT_MS) {
      console.warn(`[handleGetSession] Session ${sessionId} stuck in processing for ${Date.now() - sessionState.updatedAt}ms, marking as error`);
      const updatedSession: SessionMetadataState = {
        ...sessionState,
        status: "error",
        errorMessage: "Session timed out - processing took too long. Try closing this session and starting a new one.",
        updatedAt: Date.now(),
      };
      await data.sessions.save(updatedSession);
    }

    const sinceCursor = url.searchParams.get("since");
    const { events, nextCursor } = await data.events.listSince(
      sessionId,
      sinceCursor || undefined,
      100
    );

    logTiming(env, sessionId, "session.poll.returning", pollStart, {
      status: sessionState.status,
      eventCount: events.length,
      nextCursor: nextCursor.slice(0, 8),
      sinceCursor,
      workspaceId: effectiveWorkspaceId,
    });

    const workflowSession = await data.runtime.getWorkflowSession(sessionId) as
      | { messages?: import("../../types.js").AgentMessage[] }
      | null;

    const response: SessionResponse = {
      id: sessionState.id,
      status: sessionState.status,
      messages: workflowSession?.messages ?? [],
      events,
      nextEventCursor: nextCursor,
      errorMessage: sessionState.errorMessage,
      workspaceId: sessionState.workspaceId,
    };

    return json(response);
  } catch (error) {
    logTiming(env, sessionId, "session.poll.error", pollStart, {
      error: error instanceof Error ? error.message : String(error),
    });
    logger.error("Session poll failed", error, {
      handler: "handleGetSession",
      route: "GET /v1/session/:id",
      sessionId,
      workspaceId: effectiveWorkspaceId,
    });
    return serverError(error instanceof Error ? error.message : "Unknown error");
  }
}

/**
 * Close a session - sends close event to workflow
 */
export async function handleCloseSession(
  sessionId: string,
  env: Env,
  requestContext: RequestContext
): Promise<Response> {
  const data = getDataLayer(env);
  // Use workspace from request context
  const effectiveWorkspaceId = requestContext.workspace.id;

  try {
    // Find session scoped to workspace
    const session = await data.sessions.findByIdInWorkspace(effectiveWorkspaceId, sessionId);
      
    if (!session) {
      return notFound("Session");
    }

    if (session.status === "closed" || session.status === "expired") {
      return badRequest("Session already closed");
    }

    if (!session.workflowId) {
      return serverError("Session has no associated workflow");
    }

    const inputEvent = { type: "close" } as SessionInputEvent;
    await data.inputQueue.enqueue(sessionId, inputEvent);

    // Get workflow instance and wake it to consume the queued close event
    const workflowInstance = await env.AGENT_WORKFLOW.get(session.workflowId);
    await workflowInstance.sendEvent({
      type: "session-input",
      payload: { type: "wake" },
    });

    // Mark session as closed immediately for UI feedback
    await data.sessions.markClosed(sessionId, "user");
    await data.runtime.setActive(sessionId, false);

    return json({ ok: true, sessionId, status: "closed", workspaceId: effectiveWorkspaceId });
  } catch (error) {
    logger.error("Session close failed", error, {
      handler: "handleCloseSession",
      route: "POST /v1/session/:id/close",
      sessionId,
      workspaceId: effectiveWorkspaceId,
    });
    return serverError(error instanceof Error ? error.message : "Unknown error");
  }
}

/**
 * List sessions - returns active and recent sessions using D1
 */
export async function handleListSessions(
  url: URL,
  env: Env,
  requestContext: RequestContext
): Promise<Response> {
  const data = getDataLayer(env);
  // Use workspace from request context
  const effectiveWorkspaceId = requestContext.workspace.id;

  try {
    // Parse query parameters
    const statusFilter = url.searchParams.get("status") || "all";
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10), 100);
    const offset = parseInt(url.searchParams.get("offset") || "0", 10);

    // If specific session ID provided, return that one
    const sessionId = url.searchParams.get("sessionId");
    if (sessionId) {
      // Scoped to workspace
      const state = await data.sessions.findByIdInWorkspace(effectiveWorkspaceId, sessionId);
        
      if (state) {
        const [messageCount, isActive] = await Promise.all([
          data.events.count(sessionId),
          data.runtime.isActive(sessionId),
        ]);
        const summary: SessionSummary = {
          id: state.id,
          workspaceId: state.workspaceId,
          workflowId: state.workflowId,
          status: state.status,
          messageCount,
          updatedAt: state.updatedAt,
          isActive,
        };

        const response: SessionListResponse = { sessions: [summary], total: 1 };
        return json(response);
      }

      return json({ sessions: [], total: 0 });
    }

    // List sessions from D1 scoped to workspace
    const filter: SessionListFilter = {
      workspaceId: effectiveWorkspaceId,
      status: statusFilter as "all" | SessionStatus,
      limit,
      offset,
    };
    
    const sessions = await data.sessions.list(filter);
    const total = await data.sessions.count(filter);

    const response: SessionListResponse = { sessions, total };
    return json(response);
  } catch (error) {
    logger.error("Session list failed", error, {
      handler: "handleListSessions",
      route: "GET /v1/sessions",
      workspaceId: effectiveWorkspaceId,
    });
    return serverError(error instanceof Error ? error.message : "Unknown error");
  }
}
