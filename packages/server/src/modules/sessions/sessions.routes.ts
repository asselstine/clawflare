import { Hono } from "hono";
import type { AppBindings } from "../../http/app-bindings.js";
import { requireAuth } from "../../middleware/auth.js";
import type { Env } from "../../internal-types/index.js";
import {
  ContainerContextRepository,
  InputQueueRepository,
  SessionEventRepository,
  SessionRepository,
  SessionRuntimeRepository,
  type SessionInputEvent,
  type SessionListFilter,
  type SessionMetadataState,
} from "../../data/index.js";
import { destroyContainer } from "../tools/container/client.js";
import type { ModelProvider } from "../../types.js";
import { badRequest, json, notFound, serverError } from "../../http/responses.js";
import type { RequestContext } from "../../http/request-context.js";
import { resolveModelConnectionForNewSession } from "../model-connections/model-connections.service.js";
import { logger } from "../../lib/logger.js";
import type { SessionResponse, SessionListResponse, SessionSummary, SessionStatus } from "../../types.js";
import { createWorkflowInstance, withWorkflowInstance } from "../../runtime/workflow-handles.js";

export const sessionRoutes = new Hono<AppBindings>();
export const sessionsRoutes = new Hono<AppBindings>();

sessionRoutes.use("*", requireAuth);
sessionRoutes.post("/", (c) =>
  handleCreateSession(c.req.raw, c.env, c.get("requestContext")!)
);
sessionRoutes.get("/:id", (c) =>
  handleGetSession(c.req.param("id"), new URL(c.req.url), c.env, c.get("requestContext")!)
);
sessionRoutes.post("/:id/name", (c) =>
  handleRenameSession(c.req.param("id"), c.req.raw, c.env, c.get("requestContext")!)
);
sessionRoutes.post("/:id/close", (c) =>
  handleCloseSession(c.req.param("id"), c.env, c.get("requestContext")!)
);
sessionRoutes.post("/:id/kill", (c) =>
  handleKillSession(c.req.param("id"), c.env, c.get("requestContext")!)
);

sessionsRoutes.use("*", requireAuth);
sessionsRoutes.get("/", (c) =>
  handleListSessions(new URL(c.req.url), c.env, c.get("requestContext")!)
);

// Session Create Route Handler - POST /v1/session
// Creates a new session and workflow without enqueuing any prompts
// Used for warming up the workflow before user interaction

/**
 * Create an immediate authorization context from the request context
 */
function createAuthSession(ctx: RequestContext) {
  return {
    type: "immediate" as const,
    context: {
      userId: ctx.user.id,
      workspaceId: ctx.workspace.id,
      authTime: Date.now(),
      requestId: crypto.randomUUID(),
      version: 1,
    },
  };
}

/**
 * Create a new empty session with workflow
 * Returns session ID immediately; workflow is created but idle
 */
export async function handleCreateSession(
  request: Request,
  env: Env,
  requestContext: RequestContext
): Promise<Response> {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      sessionId?: string;
      modelConnectionId?: string;
    };
    const sessionId = body.sessionId || crypto.randomUUID();
    const workflowId = crypto.randomUUID();
    // Use workspace from request context
    const workspaceId = requestContext.workspace.id;

    const sessions = new SessionRepository(env.DB);
    const events = new SessionEventRepository(env.DB);

    // Create authorization context for this request
    const auth = createAuthSession(requestContext);

    // Resolve model connection for the session
    const resolvedModel = await resolveModelConnectionForNewSession(
      env,
      workspaceId,
      body.modelConnectionId,
      auth
    );

    // If explicit model requested but not found, return error
    if (body.modelConnectionId && !resolvedModel) {
      return badRequest(
        `Model connection "${body.modelConnectionId}" not found or not available`
      );
    }

    // Initialize session state with workspace and model info
    const initialState: SessionMetadataState = {
      id: sessionId,
      workspaceId,
      workflowId,
      status: "idle" as const,
      nextEventCursor: await events.latestCursor(sessionId),
      updatedAt: Date.now(),
      maxQueueSize: 100,
      idleTimeout: "7 days",
      modelConnectionId: resolvedModel?.id,
      modelProvider: (resolvedModel?.provider as ModelProvider | undefined),
      modelName: resolvedModel?.modelName,
    };
    await sessions.save(initialState);

    // Create persistent workflow (initially idle)
    await createWorkflowInstance(env.AGENT_WORKFLOW, {
      id: workflowId,
      params: { sessionId },
    });

    return json({
      id: sessionId,
      workspaceId,
      eventCursor: initialState.nextEventCursor,
      createdAt: Date.now(),
      modelConnection: resolvedModel
        ? {
            id: resolvedModel.id,
            provider: resolvedModel.provider,
            modelName: resolvedModel.modelName,
          }
        : undefined,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("Session creation failed", error, {
      handler: "handleCreateSession",
      route: "POST /v1/session",
      workspaceId: requestContext.workspace.id,
    });
    return badRequest(message);
  }
}

// Sessions Route Handler - /v1/session/* and /v1/sessions
// Handles session polling, closing, and listing

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
  const sessions = new SessionRepository(env.DB);
  const eventsRepo = new SessionEventRepository(env.DB);
  const runtime = new SessionRuntimeRepository(env.DB);
  // Use workspace from request context
  const effectiveWorkspaceId = requestContext.workspace.id;

  try {
    // Find session scoped to workspace
    let sessionState = await sessions.findByIdInWorkspace(effectiveWorkspaceId, sessionId);

    if (!sessionState) {
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
      await sessions.save(updatedSession);
      sessionState = updatedSession;
    }

    const sinceCursor = url.searchParams.get("since");
    const { events, nextCursor } = await eventsRepo.listSince(
      sessionId,
      sinceCursor || undefined,
      100
    );

    const includeMessages = url.searchParams.get("includeMessages");
    const shouldIncludeMessages = includeMessages === "auto"
      ? events.some((event) => event.type === "message_end") || sessionState.status === "idle" || sessionState.status === "error"
      : includeMessages !== "0" && includeMessages !== "false";

    const workflowSession = shouldIncludeMessages
      ? await runtime.getWorkflowSession(sessionId) as
        | { messages?: import("../../types.js").AgentMessage[] }
        | null
      : null;

    const response: SessionResponse = {
      id: sessionState.id,
      name: sessionState.name,
      status: sessionState.status,
      events,
      nextEventCursor: nextCursor,
      errorMessage: sessionState.errorMessage,
      workspaceId: sessionState.workspaceId,
    };

    if (shouldIncludeMessages) {
      response.messages = workflowSession?.messages ?? [];
    }

    return json(response);
  } catch (error) {
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
 * Rename a session.
 */
export async function handleRenameSession(
  sessionId: string,
  request: Request,
  env: Env,
  requestContext: RequestContext
): Promise<Response> {
  const sessions = new SessionRepository(env.DB);
  const effectiveWorkspaceId = requestContext.workspace.id;

  try {
    const body = (await request.json().catch(() => ({}))) as { name?: unknown };
    if (typeof body.name !== "string") {
      return badRequest("Invalid request. name is required");
    }

    const name = body.name.trim().replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 20);
    if (!name) {
      return badRequest("Invalid request. name must contain at least one valid character");
    }

    const renamed = await sessions.rename(sessionId, effectiveWorkspaceId, name);
    if (!renamed) {
      return notFound("Session");
    }

    return json({ ok: true, sessionId, workspaceId: effectiveWorkspaceId, name });
  } catch (error) {
    logger.error("Session rename failed", error, {
      handler: "handleRenameSession",
      route: "POST /v1/session/:id/name",
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
  const sessions = new SessionRepository(env.DB);
  const inputQueue = new InputQueueRepository(env.DB);
  const runtime = new SessionRuntimeRepository(env.DB);
  // Use workspace from request context
  const effectiveWorkspaceId = requestContext.workspace.id;

  try {
    // Find session scoped to workspace
    const session = await sessions.findByIdInWorkspace(effectiveWorkspaceId, sessionId);
      
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
    await inputQueue.enqueue(sessionId, inputEvent);

    // Get workflow instance and wake it to consume the queued close event
    await withWorkflowInstance(env.AGENT_WORKFLOW, session.workflowId, (workflowInstance) => {
      return workflowInstance.sendEvent({
        type: "session-input",
        payload: { type: "wake" },
      });
    });

    // Mark session as closed immediately for UI feedback
    await sessions.markClosed(sessionId, "user");
    await runtime.setActive(sessionId, false);

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

type WorkflowTerminalStatus = "errored" | "terminated" | "complete";

function isTerminalWorkflowStatus(status: string): status is WorkflowTerminalStatus {
  return status === "errored" || status === "terminated" || status === "complete";
}

/**
 * Force-kill a session by terminating its workflow and destroying owned containers.
 */
export async function handleKillSession(
  sessionId: string,
  env: Env,
  requestContext: RequestContext
): Promise<Response> {
  const sessions = new SessionRepository(env.DB);
  const runtime = new SessionRuntimeRepository(env.DB);
  const events = new SessionEventRepository(env.DB);
  const containerContexts = new ContainerContextRepository(env.DB);
  const effectiveWorkspaceId = requestContext.workspace.id;

  try {
    const session = await sessions.findByIdInWorkspace(effectiveWorkspaceId, sessionId);

    if (!session) {
      return notFound("Session");
    }

    const errors: string[] = [];
    let workflowStatusBefore: string | undefined;
    let workflowTerminated = false;

    if (session.workflowId) {
      try {
        const status = await withWorkflowInstance(env.AGENT_WORKFLOW, session.workflowId, async (workflowInstance) => {
          const status = await workflowInstance.status();
          if (!isTerminalWorkflowStatus(status.status)) {
            await workflowInstance.terminate();
            workflowTerminated = true;
          }
          return status;
        });
        workflowStatusBefore = status.status;
      } catch (error) {
        errors.push(`Workflow: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const ownedContainers = await containerContexts.listForSession(effectiveWorkspaceId, sessionId);
    const destroyedContainers: string[] = [];

    for (const container of ownedContainers) {
      try {
        await destroyContainer(env, container.containerId);
        destroyedContainers.push(container.containerId);
      } catch (error) {
        errors.push(
          `Container ${container.containerId}: ${error instanceof Error ? error.message : String(error)}`
        );
      } finally {
        await containerContexts.deleteForSession(
          effectiveWorkspaceId,
          sessionId,
          container.containerId
        );
      }
    }

    await events.append(sessionId, [
      {
        type: "error",
        timestamp: Date.now(),
        errorMessage: "Session killed by user.",
      },
    ]);
    await sessions.markClosed(sessionId, "user");
    await runtime.setActive(sessionId, false);

    return json({
      ok: errors.length === 0,
      sessionId,
      status: "closed",
      workspaceId: effectiveWorkspaceId,
      workflowId: session.workflowId,
      workflowStatusBefore,
      workflowTerminated,
      destroyedContainers,
      errors,
    });
  } catch (error) {
    logger.error("Session kill failed", error, {
      handler: "handleKillSession",
      route: "POST /v1/session/:id/kill",
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
  const sessionsRepo = new SessionRepository(env.DB);
  const events = new SessionEventRepository(env.DB);
  const runtime = new SessionRuntimeRepository(env.DB);
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
      const state = await sessionsRepo.findByIdInWorkspace(effectiveWorkspaceId, sessionId);
        
      if (state) {
        const [messageCount, isActive] = await Promise.all([
          events.count(sessionId),
          runtime.isActive(sessionId),
        ]);
        const summary: SessionSummary = {
          id: state.id,
          workspaceId: state.workspaceId,
          workflowId: state.workflowId,
          name: state.name,
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
    
    const sessions = await sessionsRepo.list(filter);
    const total = await sessionsRepo.count(filter);

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
