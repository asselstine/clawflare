import { Hono } from "hono";
import type { AppBindings } from "../../http/app-bindings.js";
import { requireAuth } from "../../middleware/auth.js";
import type { Env } from "../../internal-types/index.js";
import {
  ContainerRepository,
  SessionEventRepository,
  SessionMessageRepository,
  SessionRepository,
  SessionRuntimeRepository,
  SessionRunRepository,
  type SessionListFilter,
  type SessionMetadataState,
} from "../../data/index.js";
import { containerBashCancel, destroyContainer } from "../tools/container/client.js";
import { badRequest, json, notFound, serverError } from "../../http/responses.js";
import type { RequestContext } from "../../http/request-context.js";
import { resolveModelForNewSession } from "../models/models.service.js";
import { handleListSessionContainers } from "../containers/containers.routes.js";
import { logger } from "../../lib/logger.js";
import { isTimingEnabled, logTiming, timingStart } from "../../lib/timing.js";
import type { AgentMessage, DeleteSessionResponse, DeleteSessionsResponse, KillSessionResponse, Message, MessageContentBlock, SessionResponse, SessionListResponse, SessionSummary, SessionStatus, ToolCallContentBlock } from "../../types.js";
import { listToolGroups, loadSessionTools, seedDefaultSessionTools } from "../tools/tools.service.js";
import { projectAndAppendAgentEvents } from "../../runtime/message-projection.js";
import type { AgentEvent, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { AgentSessionState, AgentToolCallState, AgentTurnState } from "../../runtime/agent.js";

export const sessionRoutes = new Hono<AppBindings>();
export const sessionsRoutes = new Hono<AppBindings>();

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
sessionRoutes.get("/:id/containers", (c) =>
  handleListSessionContainers(c.env, c.get("requestContext")!, c.req.param("id"))
);
sessionRoutes.post("/:id/name", (c) =>
  handleRenameSession(c.req.param("id"), c.req.raw, c.env, c.get("requestContext")!)
);
sessionRoutes.post("/:id/close", (c) =>
  handleCloseSession(c.req.param("id"), c.env, c.get("requestContext")!)
);
sessionRoutes.post("/:id/abort", (c) =>
  handleAbortSession(c.req.param("id"), c.env, c.get("requestContext")!)
);
sessionRoutes.post("/:id/stop", (c) =>
  handleAbortSession(c.req.param("id"), c.env, c.get("requestContext")!)
);
sessionRoutes.post("/:id/kill", (c) =>
  handleKillSession(c.req.param("id"), c.env, c.get("requestContext")!)
);
sessionRoutes.delete("/:id", (c) =>
  handleDeleteSession(c.req.param("id"), c.env, c.get("requestContext")!)
);

sessionsRoutes.use("*", requireAuth);
sessionsRoutes.get("/", (c) =>
  handleListSessions(new URL(c.req.url), c.env, c.get("requestContext")!)
);
sessionsRoutes.delete("/", (c) =>
  handleDeleteSessions(c.env, c.get("requestContext")!)
);

// Session Create Route Handler - POST /v1/session
// Creates a new empty session. First prompt starts a durable session run directly.

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
 * Returns once the session metadata and default tools have been persisted.
 */
export async function handleCreateSession(
  request: Request,
  env: Env,
  requestContext: RequestContext,
  _prewarmReadyWaitMs = 0,
): Promise<Response> {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      sessionId?: string;
      modelId?: string;
    };
    const sessionId = body.sessionId || crypto.randomUUID();
    // Use workspace from request context
    const workspaceId = requestContext.workspace.id;

    const sessions = new SessionRepository(env.DB);
    const events = new SessionEventRepository(env.DB);

    // Create authorization context for this request
    const auth = createAuthSession(requestContext);

    // Resolve model for the session
    const resolvedModel = await resolveModelForNewSession(
      env,
      workspaceId,
      body.modelId,
      auth
    );

    // If explicit model requested but not found, return error
    if (body.modelId && !resolvedModel) {
      return badRequest(
        `Model "${body.modelId}" not found or not available`
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
      modelId: resolvedModel?.id,
    };
    await sessions.save(initialState);
    await seedDefaultSessionTools(env, sessionId);
    logTiming(env, sessionId, "session.created", undefined, { workspaceId });

    return json({
      id: sessionId,
      workspaceId,
      eventCursor: initialState.nextEventCursor,
      createdAt: Date.now(),
      model: resolvedModel
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
    return serverError("List session tools failed. Check server logs for details.");
  }
}

// Sessions Route Handler - /v1/session/* and /v1/sessions
// Handles session polling, closing, and listing

const PROCESSING_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const STALE_CODE_TOOL_DEFAULT_TIMEOUT_MS = 60_000;
const STALE_CODE_TOOL_GRACE_MS = 10_000;
const SESSION_EVENT_PAGE_SIZE = 100;
const SESSION_EVENT_TAIL_PAGE_SIZE = 80;
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

interface BuiltSessionResponse {
  response: SessionResponse;
  eventCount: number;
  messageCount: number;
  status: SessionStatus;
}

function sessionEventLimit(url: URL, fallback: number): number {
  const parsed = Number.parseInt(url.searchParams.get("eventLimit") ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, SESSION_EVENT_PAGE_SIZE);
}

function shouldIncludePromptHistory(url: URL): boolean {
  const value = url.searchParams.get("includePromptHistory");
  return value === "1" || value === "true";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function promptHistoryFromRuntimeSession(value: unknown): SessionResponse["promptHistory"] | undefined {
  if (!isRecord(value) || typeof value.systemPrompt !== "string" || !Array.isArray(value.messages)) {
    return undefined;
  }
  return {
    systemPrompt: value.systemPrompt,
    messages: value.messages as AgentMessage[],
  };
}

function isCodeToolCall(block: MessageContentBlock): block is ToolCallContentBlock {
  return block.type === "tool_call" &&
    (block.name === "execute_code" || block.name === "execute_stored_code");
}

function staleCodeToolTimeoutMs(block: ToolCallContentBlock): number {
  const input = isRecord(block.input) ? block.input : {};
  const timeoutMs = typeof input.timeoutMs === "number" && Number.isFinite(input.timeoutMs)
    ? input.timeoutMs
    : STALE_CODE_TOOL_DEFAULT_TIMEOUT_MS;
  return Math.max(1, Math.floor(timeoutMs)) + STALE_CODE_TOOL_GRACE_MS;
}

function staleCodeToolResult(block: ToolCallContentBlock): AgentToolResult<unknown> {
  return {
    content: [{
      type: "text",
      text: `Tool ${block.name} timed out without reporting a result.`,
    }],
    details: {
      ok: false,
      stale: true,
      reason: "tool_timeout_recovery",
      toolCallId: block.id,
      toolName: block.name,
    },
  };
}

async function recoverStaleCodeToolCalls(
  events: SessionEventRepository,
  messages: SessionMessageRepository,
  sessionId: string,
  workspaceId: string,
): Promise<void> {
  const recent = await messages.listRecent(sessionId, 20);
  const now = Date.now();
  const staleToolCalls = recent.flatMap((message: Message) =>
    message.content
      .filter(isCodeToolCall)
      .filter((block) => block.status === "queued" || block.status === "running")
      .filter((block) => now - message.updatedAt >= staleCodeToolTimeoutMs(block))
      .map((block) => ({ block }))
  );

  if (staleToolCalls.length === 0) return;

  await projectAndAppendAgentEvents(events, messages, sessionId, staleToolCalls.map(({ block }): AgentEvent => ({
    type: "tool_execution_end",
    toolCallId: block.id,
    toolName: block.name,
    result: staleCodeToolResult(block),
    isError: true,
  } as AgentEvent)), { workspaceId });
}

function isAgentSessionState(value: unknown): value is AgentSessionState {
  return isRecord(value) &&
    typeof value.id === "string" &&
    Array.isArray(value.messages) &&
    Array.isArray(value.turns) &&
    isRecord(value.toolCalls) &&
    typeof value.status === "string";
}

function latestTurn(session: AgentSessionState): AgentTurnState | undefined {
  return session.turns.at(-1);
}

function containerBashAsyncState(value: unknown): {
  containerId: string;
  commandId: string;
} | undefined {
  if (!isRecord(value) || value.kind !== "container_bash") return undefined;
  if (typeof value.containerId !== "string" || typeof value.commandId !== "string") return undefined;
  return { containerId: value.containerId, commandId: value.commandId };
}

function stoppedToolResult(toolCall: AgentToolCallState): AgentToolResult<unknown> {
  return {
    content: [{ type: "text", text: "Tool aborted by user." }],
    details: {
      ok: false,
      aborted: true,
      stopped: true,
      reason: "user_stop",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
    },
  };
}

function stoppedToolResultMessage(toolCall: AgentToolCallState, result: AgentToolResult<unknown>): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    content: result.content,
    details: result.details,
    isError: true,
    timestamp: Date.now(),
  };
}

async function stopRunningWorkflowTools(
  env: Env,
  runtime: SessionRuntimeRepository,
  events: SessionEventRepository,
  messages: SessionMessageRepository,
  sessionId: string,
  workspaceId: string,
): Promise<{ stoppedToolCallIds: string[]; errors: string[] }> {
  const stored = await runtime.getWorkflowSession(sessionId);
  if (!isAgentSessionState(stored)) return { stoppedToolCallIds: [], errors: [] };

  const currentTurn = latestTurn(stored);
  const currentTurnToolCallIds = new Set(currentTurn?.toolCallIds ?? []);
  const stoppable = Object.values(stored.toolCalls)
    .filter((toolCall): toolCall is AgentToolCallState => Boolean(toolCall))
    .filter((toolCall) => currentTurnToolCallIds.has(toolCall.id))
    .filter((toolCall) => toolCall.status === "pending" || toolCall.status === "running");
  if (stoppable.length === 0) return { stoppedToolCallIds: [], errors: [] };

  const errors: string[] = [];
  for (const toolCall of stoppable) {
    const asyncState = containerBashAsyncState(toolCall.asyncState);
    if (!asyncState || toolCall.status !== "running") continue;
    try {
      await containerBashCancel(env, asyncState.containerId, asyncState.commandId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${toolCall.id}: ${message}`);
      logger.warn("Failed to cancel running container bash command during session stop", {
        sessionId,
        toolCallId: toolCall.id,
        containerId: asyncState.containerId,
        commandId: asyncState.commandId,
        error: message,
      });
    }
  }

  const stoppedIds = new Set(stoppable.map((toolCall) => toolCall.id));
  const stoppedResults = new Map(stoppable.map((toolCall) => [toolCall.id, stoppedToolResult(toolCall)]));
  const stoppedMessages = stoppable
    .filter((toolCall) => !stored.messages.some((message) =>
      isRecord(message) && message.role === "toolResult" && message.toolCallId === toolCall.id
    ))
    .map((toolCall) => stoppedToolResultMessage(toolCall, stoppedResults.get(toolCall.id)!));

  const stoppedSession: AgentSessionState = {
    ...stored,
    updatedAt: Date.now(),
    status: "idle",
    messages: [...stored.messages, ...stoppedMessages],
    toolCalls: Object.fromEntries(Object.entries(stored.toolCalls).map(([id, toolCall]) => {
      if (!stoppedIds.has(id)) return [id, toolCall];
      return [id, {
        ...toolCall,
        status: "aborted",
        isError: true,
        result: stoppedResults.get(id),
        asyncState: undefined,
      }];
    })),
    turns: currentTurn
      ? stored.turns.map((turn) => turn.id === currentTurn.id
        ? {
            ...turn,
            status: "error",
            toolResultIds: [...new Set([...turn.toolResultIds, ...stoppable.map((toolCall) => toolCall.id)])],
          }
        : turn)
      : stored.turns,
  };

  await runtime.saveWorkflowSession(sessionId, stoppedSession);
  await projectAndAppendAgentEvents(events, messages, sessionId, stoppable.map((toolCall): AgentEvent => ({
    type: "tool_execution_end",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    result: stoppedResults.get(toolCall.id)!,
    isError: true,
  } as AgentEvent)), { workspaceId });

  return { stoppedToolCallIds: stoppable.map((toolCall) => toolCall.id), errors };
}

async function buildSessionResponse(
  sessionId: string,
  url: URL,
  env: Env,
  requestContext: RequestContext,
): Promise<Response | BuiltSessionResponse> {
  const sessions = new SessionRepository(env.DB);
  const eventsRepo = new SessionEventRepository(env.DB);
  const messagesRepo = new SessionMessageRepository(env.DB);
  const runtimeRepo = new SessionRuntimeRepository(env.DB);
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

  await recoverStaleCodeToolCalls(eventsRepo, messagesRepo, sessionId, effectiveWorkspaceId);

  const sinceCursor = url.searchParams.get("since");
  const eventWindow = url.searchParams.get("eventWindow");
  const eventLimit = sessionEventLimit(url, SESSION_EVENT_PAGE_SIZE);
  const eventsStart = timingStart();
  const eventPage = !sinceCursor && eventWindow === "tail"
    ? {
        events: await eventsRepo.listRecent(sessionId, eventLimit),
        nextCursor: sessionState.nextEventCursor,
      }
    : !sinceCursor && eventWindow === "before"
      ? {
          events: await eventsRepo.listBefore(sessionId, url.searchParams.get("before") ?? "0", eventLimit),
          nextCursor: url.searchParams.get("before") ?? "0",
        }
      : await eventsRepo.listSince(
          sessionId,
          sinceCursor || undefined,
          eventLimit
        );
  const { events, nextCursor } = eventPage;
  logTiming(env, sessionId, "session.poll.events_loaded", eventsStart, {
    workspaceId: effectiveWorkspaceId,
    since: sinceCursor || undefined,
    eventWindow: eventWindow ?? undefined,
    eventCount: events.length,
    nextCursor,
  });

  const messagesStart = timingStart();
  const { messages, nextCursor: nextMessageCursor } = await messagesRepo.list(sessionId, {
    after: url.searchParams.get("afterMessage") ?? undefined,
    before: url.searchParams.get("beforeMessage") ?? undefined,
    limit: sessionEventLimit(url, SESSION_EVENT_TAIL_PAGE_SIZE),
  });
  logTiming(env, sessionId, "session.poll.messages_loaded", messagesStart, {
    workspaceId: effectiveWorkspaceId,
    messageCount: messages.length,
    nextMessageCursor,
  });

  const promptHistory = shouldIncludePromptHistory(url)
    ? promptHistoryFromRuntimeSession(await runtimeRepo.getWorkflowSession(sessionId))
    : undefined;

  const response: SessionResponse = {
    id: sessionState.id,
    name: sessionState.name,
    status: sessionState.status,
    messages,
    events,
    nextEventCursor: nextCursor,
    nextMessageCursor,
    promptHistory,
    errorMessage: sessionState.status === "error" ? sessionState.errorMessage : undefined,
    workspaceId: sessionState.workspaceId,
  };

  return {
    response,
    eventCount: events.length,
    messageCount: messages.length,
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
      eventCount: built.eventCount,
      messageCount: built.messageCount,
      status: built.status,
    });
    logTiming(env, sessionId, "session.poll.response", routeStart, {
      workspaceId: effectiveWorkspaceId,
      status: 200,
      eventCount: built.eventCount,
      messageCount: built.messageCount,
    });
    return json(built.response);
  } catch (error) {
    logger.error("Session poll failed", error, {
      handler: "handleGetSession",
      route: "GET /v1/session/:id",
      sessionId,
      workspaceId: effectiveWorkspaceId,
    });
    return serverError("Session poll failed. Check server logs for details.");
  }
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
              error: "Session event stream failed. Check server logs for details.",
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
    return serverError("Session event stream failed. Check server logs for details.");
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
 * Close a session and ask any active durable run to stop between steps.
 */
export async function handleCloseSession(
  sessionId: string,
  env: Env,
  requestContext: RequestContext
): Promise<Response> {
  const sessions = new SessionRepository(env.DB);
  const runtime = new SessionRuntimeRepository(env.DB);
  const runs = new SessionRunRepository(env.DB);
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

    const activeRun = await runs.findActiveForSession(sessionId);
    if (activeRun) {
      await runs.requestCancel(activeRun.id);
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

/**
 * Cancel the active durable run without closing the session.
 */
export async function handleAbortSession(
  sessionId: string,
  env: Env,
  requestContext: RequestContext
): Promise<Response> {
  const sessions = new SessionRepository(env.DB);
  const runtime = new SessionRuntimeRepository(env.DB);
  const events = new SessionEventRepository(env.DB);
  const messages = new SessionMessageRepository(env.DB);
  const runs = new SessionRunRepository(env.DB);
  const effectiveWorkspaceId = requestContext.workspace.id;

  try {
    const session = await sessions.findByIdInWorkspace(effectiveWorkspaceId, sessionId);

    if (!session) {
      return notFound("Session");
    }

    if (session.status === "closed" || session.status === "expired") {
      return badRequest("Session already closed");
    }

    const stoppedTools = await stopRunningWorkflowTools(
      env,
      runtime,
      events,
      messages,
      sessionId,
      effectiveWorkspaceId,
    );
    const activeRun = await runs.findActiveForSession(sessionId);
    if (!activeRun) {
      if (stoppedTools.stoppedToolCallIds.length > 0) {
        await sessions.save({
          ...session,
          status: "idle",
          updatedAt: Date.now(),
          errorMessage: undefined,
        });
        await runtime.setActive(sessionId, false);
      }
      return json({
        ok: stoppedTools.errors.length === 0,
        sessionId,
        status: stoppedTools.stoppedToolCallIds.length > 0 ? "idle" : session.status,
        aborted: stoppedTools.stoppedToolCallIds.length > 0,
        stopped: stoppedTools.stoppedToolCallIds.length > 0,
        stoppedToolCallIds: stoppedTools.stoppedToolCallIds,
        toolStopErrors: stoppedTools.errors,
        workspaceId: effectiveWorkspaceId,
      });
    }

    await runs.cancel(activeRun.id);
    await sessions.save({
      ...session,
      status: "idle",
      updatedAt: Date.now(),
      errorMessage: undefined,
    });
    await runtime.setActive(sessionId, false);
    return json({
      ok: stoppedTools.errors.length === 0,
      sessionId,
      status: "idle",
      aborted: true,
      stopped: true,
      stoppedToolCallIds: stoppedTools.stoppedToolCallIds,
      toolStopErrors: stoppedTools.errors,
      workspaceId: effectiveWorkspaceId,
    });
  } catch (error) {
    logger.error("Session abort failed", error, {
      handler: "handleAbortSession",
      route: "POST /v1/session/:id/abort",
      sessionId,
      workspaceId: effectiveWorkspaceId,
    });
    return serverError(error instanceof Error ? error.message : "Unknown error");
  }
}

/**
 * Force-kill a session by cancelling its durable run and destroying owned containers.
 */
async function killSessionResources(
  sessionId: string,
  env: Env,
  requestContext: RequestContext,
  session: SessionMetadataState,
  options: { appendKillEvent: boolean },
): Promise<KillSessionResponse> {
  const runtime = new SessionRuntimeRepository(env.DB);
  const events = new SessionEventRepository(env.DB);
  const runs = new SessionRunRepository(env.DB);
  const containers = new ContainerRepository(env.DB);
  const effectiveWorkspaceId = requestContext.workspace.id;

  const errors: string[] = [];
  let runCancelled = false;

  const activeRun = await runs.findActiveForSession(sessionId);
  if (activeRun) {
    await runs.cancel(activeRun.id);
    runCancelled = true;
  }

  const ownedContainers = await containers.listForSession(effectiveWorkspaceId, sessionId);
  const destroyedContainers: string[] = [];

  for (const container of ownedContainers) {
    const linksBeforeUnlink = await containers.listLinksForContainer(effectiveWorkspaceId, container.id);
    try {
      if (linksBeforeUnlink.length <= 1) {
        await destroyContainer(env, container.id);
        await containers.markDestroyed(effectiveWorkspaceId, container.id);
        destroyedContainers.push(container.id);
      } else {
        await containers.unlinkSession(effectiveWorkspaceId, sessionId, container.id);
      }
    } catch (error) {
      errors.push(
        `Container ${container.id}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  if (options.appendKillEvent) {
    await events.append(sessionId, [
      {
        type: "error",
        timestamp: Date.now(),
        errorMessage: "Session killed by user.",
      },
    ]);
  }
  await new SessionRepository(env.DB).markClosed(sessionId, "user");
  await runtime.setActive(sessionId, false);

  return {
    ok: errors.length === 0,
    sessionId,
    status: "closed",
    workspaceId: effectiveWorkspaceId,
    workflowId: session.workflowId,
    workflowStatusBefore: activeRun?.status,
    workflowTerminated: runCancelled,
    destroyedContainers,
    errors,
  };
}

export async function handleKillSession(
  sessionId: string,
  env: Env,
  requestContext: RequestContext
): Promise<Response> {
  const sessions = new SessionRepository(env.DB);
  const effectiveWorkspaceId = requestContext.workspace.id;

  try {
    const session = await sessions.findByIdInWorkspace(effectiveWorkspaceId, sessionId);

    if (!session) {
      return notFound("Session");
    }

    const killed = await killSessionResources(sessionId, env, requestContext, session, {
      appendKillEvent: true,
    });

    return json(killed);
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
 * Delete a session after releasing any active resources.
 */
export async function handleDeleteSession(
  sessionId: string,
  env: Env,
  requestContext: RequestContext
): Promise<Response> {
  const sessions = new SessionRepository(env.DB);
  const effectiveWorkspaceId = requestContext.workspace.id;

  try {
    const session = await sessions.findByIdInWorkspace(effectiveWorkspaceId, sessionId);

    if (!session) {
      return notFound("Session");
    }

    return json(await deleteSessionAfterCleanup(sessionId, env, requestContext, session));
  } catch (error) {
    logger.error("Session delete failed", error, {
      handler: "handleDeleteSession",
      route: "DELETE /v1/session/:id",
      sessionId,
      workspaceId: effectiveWorkspaceId,
    });
    return serverError(error instanceof Error ? error.message : "Unknown error");
  }
}

async function deleteSessionAfterCleanup(
  sessionId: string,
  env: Env,
  requestContext: RequestContext,
  session: SessionMetadataState,
): Promise<DeleteSessionResponse> {
  const sessions = new SessionRepository(env.DB);
  const effectiveWorkspaceId = requestContext.workspace.id;
  const alreadyTerminal = session.status === "closed" || session.status === "expired";
  const killed = await killSessionResources(sessionId, env, requestContext, session, {
    appendKillEvent: !alreadyTerminal,
  });
  const deleted = await sessions.delete(sessionId, effectiveWorkspaceId);

  return {
    ok: killed.ok && deleted,
    sessionId,
    workspaceId: effectiveWorkspaceId,
    deleted,
    killedBeforeDelete: !alreadyTerminal,
    workflowTerminated: killed.workflowTerminated,
    destroyedContainers: killed.destroyedContainers,
    errors: killed.errors,
  };
}

/**
 * Delete every session in the workspace after releasing active resources.
 */
export async function handleDeleteSessions(
  env: Env,
  requestContext: RequestContext
): Promise<Response> {
  const sessions = new SessionRepository(env.DB);
  const effectiveWorkspaceId = requestContext.workspace.id;

  try {
    const targets: Array<SessionMetadataState | null> = [];
    const pageSize = 100;
    for (let offset = 0; ; offset += pageSize) {
      const page = await sessions.list({
        workspaceId: effectiveWorkspaceId,
        status: "all",
        limit: pageSize,
        offset,
      });
      targets.push(...await Promise.all(page.map((session) => sessions.findByIdInWorkspace(effectiveWorkspaceId, session.id))));
      if (page.length < pageSize) break;
    }

    const results: DeleteSessionResponse[] = [];
    for (const target of targets) {
      if (!target) continue;
      results.push(await deleteSessionAfterCleanup(target.id, env, requestContext, target));
    }

    const errors = results.flatMap((result) => result.errors.map((error) => `${result.sessionId}: ${error}`));
    const response: DeleteSessionsResponse = {
      ok: results.every((result) => result.ok && result.deleted),
      workspaceId: effectiveWorkspaceId,
      deleted: results.filter((result) => result.deleted).length,
      total: results.length,
      results,
      errors,
    };

    return json(response);
  } catch (error) {
    logger.error("Bulk session delete failed", error, {
      handler: "handleDeleteSessions",
      route: "DELETE /v1/sessions",
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
  const containers = new ContainerRepository(env.DB);
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
        const sessionContainers = await containers.listForSession(effectiveWorkspaceId, sessionId);
        const summary: SessionSummary = {
          id: state.id,
          workspaceId: state.workspaceId,
          workflowId: state.workflowId,
          name: state.name,
          status: state.status,
          messageCount,
          updatedAt: state.updatedAt,
          isActive,
          containers: sessionContainers.map((container) => container.id),
          containerDetails: sessionContainers,
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
    
    const sessions = await Promise.all((await sessionsRepo.list(filter)).map(async (session) => {
      const sessionContainers = await containers.listForSession(effectiveWorkspaceId, session.id);
      return {
        ...session,
        containers: sessionContainers.map((container) => container.id),
        containerDetails: sessionContainers,
      };
    }));
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
