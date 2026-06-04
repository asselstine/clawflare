import { Hono } from "hono";
import type { AppBindings } from "../../http/app-bindings.js";
import { requireAuth } from "../../middleware/auth.js";
import type { Env } from "../../internal-types/index.js";
import {
  ContainerContextRepository,
  SessionEventRepository,
  SessionRepository,
  SessionRuntimeRepository,
  type SessionListFilter,
  type SessionMetadataState,
} from "../../data/index.js";
import { destroyContainer } from "../tools/container/client.js";
import type { ModelProvider } from "../../types.js";
import { badRequest, json, notFound, serverError } from "../../http/responses.js";
import type { RequestContext } from "../../http/request-context.js";
import { resolveModelConnectionForNewSession } from "../model-connections/model-connections.service.js";
import { logger } from "../../lib/logger.js";
import { isTimingEnabled, logTiming, timingStart } from "../../lib/timing.js";
import type { SessionResponse, SessionListResponse, SessionSummary, SessionStatus } from "../../types.js";
import { createWorkflowInstance, withWorkflowInstance } from "../../runtime/workflow-handles.js";
import { listToolGroups, loadSessionTools, seedDefaultSessionTools } from "../tools/tools.service.js";

export const sessionRoutes = new Hono<AppBindings>();
export const sessionsRoutes = new Hono<AppBindings>();

const WORKFLOW_PREWARM_READY_WAIT_MS = 5000;
const WORKFLOW_PREWARM_READY_POLL_MS = 100;

sessionRoutes.use("*", requireAuth);
sessionRoutes.post("/", (c) =>
  handleCreateSession(c.req.raw, c.env, c.get("requestContext")!)
);
sessionRoutes.get("/:id/events/ws", (c) =>
  handleStreamSessionEventsWebSocket(c.req.param("id"), new URL(c.req.url), c.req.raw, c.env, c.get("requestContext")!, c.executionCtx)
);
sessionRoutes.get("/:id/events", (c) =>
  handleStreamSessionEvents(c.req.param("id"), new URL(c.req.url), c.req.raw, c.env, c.get("requestContext")!)
);
sessionRoutes.get("/:id", (c) =>
  handleGetSession(c.req.param("id"), new URL(c.req.url), c.env, c.get("requestContext")!)
);
sessionRoutes.get("/:id/tools", (c) =>
  handleListSessionTools(c.req.param("id"), c.env, c.get("requestContext")!)
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
// Creates a new empty session and waits for its workflow to reach the input listener.
// This shifts workflow startup latency out of the first prompt path.

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
 * Create a new empty session.
 * Returns once the workflow is ready for input or the readiness wait times out.
 */
export async function handleCreateSession(
  request: Request,
  env: Env,
  requestContext: RequestContext,
  prewarmReadyWaitMs = WORKFLOW_PREWARM_READY_WAIT_MS,
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
    const runtime = new SessionRuntimeRepository(env.DB);

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
      workflowId: "",
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
    await seedDefaultSessionTools(env, sessionId);

    const prewarmWorkflow = async () => {
      const prewarmStart = timingStart();
      try {
        // Prewarm exists specifically to hide Cloudflare Workflow creation/startup latency from
        // the first prompt. We only call it ready once the Workflow has actually reached
        // waitForEvent; createWorkflowInstance() can return before the Workflow has started.
        await createWorkflowInstance(env.AGENT_WORKFLOW, {
          id: workflowId,
          params: { sessionId },
        });
        const waitingAt = await waitForWorkflowWaiting(runtime, sessionId, prewarmReadyWaitMs);
        if (waitingAt) {
          await runtime.saveWorkflowId(sessionId, workflowId);
        }
        logTiming(env, sessionId, waitingAt ? "session.workflow.prewarmed" : "session.workflow.prewarm_timeout", prewarmStart, {
          workspaceId,
          workflowId,
          ready: Boolean(waitingAt),
          waitingAt,
        });
      } catch (error) {
        logger.error("Workflow prewarm failed", error, {
          sessionId,
          workspaceId,
          workflowId,
        });
      }
    };
    await prewarmWorkflow();

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

export async function handleListSessionTools(
  sessionId: string,
  env: Env,
  requestContext: RequestContext
): Promise<Response> {
  try {
    const sessions = new SessionRepository(env.DB);
    const session = await sessions.findByIdInWorkspace(requestContext.workspace.id, sessionId);
    if (!session) {
      return notFound("Session");
    }

    return json({
      groups: listToolGroups(),
      tools: await loadSessionTools(env, sessionId),
    });
  } catch (error) {
    logger.error("List session tools failed", error, {
      handler: "handleListSessionTools",
      route: "GET /v1/sessions/:id/tools",
      sessionId,
      workspaceId: requestContext.workspace.id,
    });
    return serverError(error instanceof Error ? error.message : "Unknown error");
  }
}

// Sessions Route Handler - /v1/session/* and /v1/sessions
// Handles session polling, closing, and listing

const PROCESSING_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const SESSION_EVENT_PAGE_SIZE = 100;
const SESSION_EVENT_STREAM_POLL_MS = 100;
const SESSION_EVENT_STREAM_FAST_POLL_MS = 50;
const SESSION_EVENT_STREAM_FAST_POLL_WINDOW_MS = 1500;
const SESSION_EVENT_STREAM_HEARTBEAT_MS = 15000;
const SESSION_EVENT_STREAM_MAX_IDLE_MS = 30 * 60 * 1000;

function isSessionStreamTerminal(status: SessionStatus): boolean {
  return status === "idle" || status === "error" || status === "closed" || status === "expired";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForWorkflowWaiting(
  runtime: SessionRuntimeRepository,
  sessionId: string,
  timeoutMs: number,
): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const waitingAt = await runtime.getWorkflowWaitingAt(sessionId);
    if (waitingAt !== null) return waitingAt;
    await delay(WORKFLOW_PREWARM_READY_POLL_MS);
  }
  return runtime.getWorkflowWaitingAt(sessionId);
}

interface BuiltSessionResponse {
  response: SessionResponse;
  shouldIncludeMessages: boolean;
  eventCount: number;
  status: SessionStatus;
}

async function buildSessionResponse(
  sessionId: string,
  url: URL,
  env: Env,
  requestContext: RequestContext,
): Promise<Response | BuiltSessionResponse> {
  const sessions = new SessionRepository(env.DB);
  const eventsRepo = new SessionEventRepository(env.DB);
  const runtime = new SessionRuntimeRepository(env.DB);
  const effectiveWorkspaceId = requestContext.workspace.id;

  const lookupStart = timingStart();
  let sessionState = await sessions.findByIdInWorkspace(effectiveWorkspaceId, sessionId);
  logTiming(env, sessionId, "session.poll.lookup", lookupStart, {
    workspaceId: effectiveWorkspaceId,
    found: Boolean(sessionState),
    status: sessionState?.status,
  });

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
    const recoveryStart = timingStart();
    await sessions.save(updatedSession);
    logTiming(env, sessionId, "session.poll.timeout_recovered", recoveryStart, {
      workspaceId: effectiveWorkspaceId,
    });
    sessionState = updatedSession;
  }

  const sinceCursor = url.searchParams.get("since");
  const eventsStart = timingStart();
  const { events, nextCursor } = await eventsRepo.listSince(
    sessionId,
    sinceCursor || undefined,
    SESSION_EVENT_PAGE_SIZE
  );
  logTiming(env, sessionId, "session.poll.events_loaded", eventsStart, {
    workspaceId: effectiveWorkspaceId,
    since: sinceCursor || undefined,
    eventCount: events.length,
    nextCursor,
  });

  const includeMessages = url.searchParams.get("includeMessages");
  const shouldIncludeMessages = includeMessages === "auto"
    ? events.some((event) => event.type === "message_end") || sessionState.status === "idle" || sessionState.status === "error"
    : includeMessages !== "0" && includeMessages !== "false";
  logTiming(env, sessionId, "session.poll.messages_decided", undefined, {
    workspaceId: effectiveWorkspaceId,
    includeMessages: includeMessages ?? undefined,
    shouldIncludeMessages,
  });

  const workflowSession = shouldIncludeMessages
    ? await loadWorkflowSessionForPoll(env, sessionId, runtime)
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

  return {
    response,
    shouldIncludeMessages,
    eventCount: events.length,
    status: sessionState.status,
  };
}

/**
 * Get session state - polls for messages and events
 */
export async function handleGetSession(
  sessionId: string,
  url: URL,
  env: Env,
  requestContext: RequestContext
): Promise<Response> {
  const routeStart = timingStart();
  // Use workspace from request context
  const effectiveWorkspaceId = requestContext.workspace.id;

  try {
    logTiming(env, sessionId, "session.poll.start", undefined, {
      workspaceId: effectiveWorkspaceId,
      since: url.searchParams.get("since") ?? undefined,
      includeMessages: url.searchParams.get("includeMessages") ?? undefined,
    });

    const built = await buildSessionResponse(sessionId, url, env, requestContext);
    if (built instanceof Response) return built;

    logSessionPollResponseSize(env, sessionId, built.response, {
      workspaceId: effectiveWorkspaceId,
      shouldIncludeMessages: built.shouldIncludeMessages,
      eventCount: built.eventCount,
      messageCount: built.response.messages?.length,
      status: built.status,
    });
    logTiming(env, sessionId, "session.poll.response", routeStart, {
      workspaceId: effectiveWorkspaceId,
      status: 200,
      shouldIncludeMessages: built.shouldIncludeMessages,
      eventCount: built.eventCount,
      messageCount: built.response.messages?.length,
    });
    return json(built.response);
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

async function loadWorkflowSessionForPoll(
  env: Env,
  sessionId: string,
  runtime: SessionRuntimeRepository,
): Promise<{ messages?: import("../../types.js").AgentMessage[] } | null> {
  const messagesStart = timingStart();
  const workflowSession = await runtime.getWorkflowSession(sessionId) as
    | { messages?: import("../../types.js").AgentMessage[] }
    | null;
  logTiming(env, sessionId, "session.poll.messages_loaded", messagesStart, {
    messageCount: workflowSession?.messages?.length ?? 0,
  });
  return workflowSession;
}

function logSessionPollResponseSize(
  env: Env,
  sessionId: string,
  response: SessionResponse,
  details: Record<string, unknown>,
): void {
  if (!isTimingEnabled(env)) return;

  logTiming(env, sessionId, "session.poll.response_serialized", undefined, {
    ...details,
    responseBytes: JSON.stringify(response).length,
  });
}

/**
 * Stream session state updates using Server-Sent Events.
 */
export async function handleStreamSessionEvents(
  sessionId: string,
  url: URL,
  request: Request,
  env: Env,
  requestContext: RequestContext
): Promise<Response> {
  const effectiveWorkspaceId = requestContext.workspace.id;
  const encoder = new TextEncoder();

  try {
    const initial = await buildSessionResponse(sessionId, url, env, requestContext);
    if (initial instanceof Response) return initial;

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        let cursor = url.searchParams.get("since") || undefined;
        let lastStatus: SessionStatus | undefined;
        let lastSentAt = Date.now();
        let closed = false;

        const send = (event: string, data?: SessionResponse): void => {
          if (closed) return;
          const payload = data
            ? `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
            : `: ${event}\n\n`;
          controller.enqueue(encoder.encode(payload));
          lastSentAt = Date.now();
        };

        request.signal.addEventListener("abort", () => {
          closed = true;
        });

        try {
          let next = initial.response;
          const startedAt = Date.now();

          while (!closed) {
            const hasNewEvents = next.events.length > 0;
            const statusChanged = next.status !== lastStatus;
            const terminal = isSessionStreamTerminal(next.status);
            const hasFullPage = next.events.length >= SESSION_EVENT_PAGE_SIZE;

            if (hasNewEvents || statusChanged || terminal) {
              send("session", next);
              cursor = next.nextEventCursor;
              lastStatus = next.status;
            } else if (Date.now() - lastSentAt >= SESSION_EVENT_STREAM_HEARTBEAT_MS) {
              send("heartbeat");
            }

            if (terminal && !hasFullPage) {
              break;
            }

            if (Date.now() - startedAt >= SESSION_EVENT_STREAM_MAX_IDLE_MS) {
              break;
            }

            if (!hasFullPage) {
              // Poll a bit faster right after the client submits a prompt so newly appended
              // workflow events are visible quickly, then settle back to reduce D1 traffic.
              const elapsed = Date.now() - startedAt;
              const pollDelay = elapsed < SESSION_EVENT_STREAM_FAST_POLL_WINDOW_MS
                ? SESSION_EVENT_STREAM_FAST_POLL_MS
                : SESSION_EVENT_STREAM_POLL_MS;
              await delay(pollDelay);
            }

            const nextUrl = new URL(url);
            if (cursor) nextUrl.searchParams.set("since", cursor);
            const built = await buildSessionResponse(sessionId, nextUrl, env, requestContext);
            if (built instanceof Response) {
              closed = true;
              break;
            }
            next = built.response;
          }
        } catch (error) {
          logger.error("Session event stream failed", error, {
            handler: "handleStreamSessionEvents",
            route: "GET /v1/session/:id/events",
            sessionId,
            workspaceId: effectiveWorkspaceId,
          });
          if (!closed) {
            controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({
              error: error instanceof Error ? error.message : "Unknown error",
            })}\n\n`));
          }
        } finally {
          if (!closed) {
            controller.close();
          }
        }
      },
      cancel() {
        request.signal.dispatchEvent(new Event("abort"));
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
      },
    });
  } catch (error) {
    logger.error("Session event stream failed", error, {
      handler: "handleStreamSessionEvents",
      route: "GET /v1/session/:id/events",
      sessionId,
      workspaceId: effectiveWorkspaceId,
    });
    return serverError(error instanceof Error ? error.message : "Unknown error");
  }
}

/**
 * Stream session state updates over WebSocket.
 *
 * Each "session" message contains a full SessionResponse, including the newly
 * appended events and messages when includeMessages=auto decides they are needed.
 * That lets the CLI update directly from the socket without issuing a follow-up poll.
 */
export async function handleStreamSessionEventsWebSocket(
  sessionId: string,
  url: URL,
  request: Request,
  env: Env,
  requestContext: RequestContext,
  executionCtx?: ExecutionContext,
): Promise<Response> {
  const effectiveWorkspaceId = requestContext.workspace.id;

  if (request.headers.get("Upgrade") !== "websocket") {
    return badRequest("Expected WebSocket upgrade");
  }

  try {
    const initial = await buildSessionResponse(sessionId, url, env, requestContext);
    if (initial instanceof Response) return initial;

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();

    let closed = false;
    server.addEventListener("close", () => {
      closed = true;
    });
    server.addEventListener("error", () => {
      closed = true;
    });

    const run = async () => {
      let cursor = url.searchParams.get("since") || undefined;
      let lastStatus: SessionStatus | undefined;
      let lastSentAt = Date.now();

      const send = (message: unknown): boolean => {
        if (closed) return false;
        try {
          server.send(JSON.stringify(message));
        } catch (error) {
          // The CLI closes the socket as soon as a turn is complete or when a user aborts.
          // Cloudflare reports a send after that close as "Network connection lost"; treat it
          // as a normal disconnect rather than surfacing a noisy Worker exception.
          closed = true;
          if (!isWebSocketDisconnectError(error)) {
            logger.error("Session WebSocket send failed", error, {
              handler: "handleStreamSessionEventsWebSocket",
              route: "GET /v1/session/:id/events/ws",
              sessionId,
              workspaceId: effectiveWorkspaceId,
            });
          }
          return false;
        }
        lastSentAt = Date.now();
        return true;
      };

      try {
        let next = initial.response;
        const startedAt = Date.now();

        while (!closed) {
          const hasNewEvents = next.events.length > 0;
          const statusChanged = next.status !== lastStatus;
          const terminal = isSessionStreamTerminal(next.status);
          const hasFullPage = next.events.length >= SESSION_EVENT_PAGE_SIZE;

          if (hasNewEvents || statusChanged || terminal) {
            if (!send({ type: "session", session: next })) break;
            cursor = next.nextEventCursor;
            lastStatus = next.status;
          } else if (Date.now() - lastSentAt >= SESSION_EVENT_STREAM_HEARTBEAT_MS) {
            if (!send({ type: "heartbeat" })) break;
          }

          if (terminal && !hasFullPage) {
            break;
          }

          if (Date.now() - startedAt >= SESSION_EVENT_STREAM_MAX_IDLE_MS) {
            break;
          }

          if (!hasFullPage) {
            // Keep the WebSocket responsive around submit time without forcing the CLI
            // to poll. This is intentionally a thin bridge over the existing D1-backed
            // session log rather than a separate in-memory notification system.
            const elapsed = Date.now() - startedAt;
            const pollDelay = elapsed < SESSION_EVENT_STREAM_FAST_POLL_WINDOW_MS
              ? SESSION_EVENT_STREAM_FAST_POLL_MS
              : SESSION_EVENT_STREAM_POLL_MS;
            await delay(pollDelay);
          }

          const nextUrl = new URL(url);
          if (cursor) nextUrl.searchParams.set("since", cursor);
          const built = await buildSessionResponse(sessionId, nextUrl, env, requestContext);
          if (built instanceof Response) {
            send({ type: "error", error: "Session is no longer available" });
            break;
          }
          next = built.response;
        }
      } catch (error) {
        if (!isWebSocketDisconnectError(error)) {
          logger.error("Session WebSocket event stream failed", error, {
            handler: "handleStreamSessionEventsWebSocket",
            route: "GET /v1/session/:id/events/ws",
            sessionId,
            workspaceId: effectiveWorkspaceId,
          });
        }
        send({ type: "error", error: error instanceof Error ? error.message : "Unknown error" });
      } finally {
        if (!closed) {
          closed = true;
          try {
            server.close();
          } catch {
            // Already closed.
          }
        }
      }
    };

    if (executionCtx) {
      executionCtx.waitUntil(run());
    } else {
      void run();
    }

    return new Response(null, { status: 101, webSocket: client });
  } catch (error) {
    logger.error("Session WebSocket event stream failed", error, {
      handler: "handleStreamSessionEventsWebSocket",
      route: "GET /v1/session/:id/events/ws",
      sessionId,
      workspaceId: effectiveWorkspaceId,
    });
    return serverError(error instanceof Error ? error.message : "Unknown error");
  }
}

function isWebSocketDisconnectError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return message.includes("network connection lost") ||
    message.includes("websocket is not open") ||
    message.includes("socket is closed");
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

    if (session.workflowId) {
      // Get workflow instance and send the close event directly.
      await withWorkflowInstance(env.AGENT_WORKFLOW, session.workflowId, (workflowInstance) => {
        return workflowInstance.sendEvent({
          type: "session-input",
          payload: { type: "close" },
        });
      });
    }

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
