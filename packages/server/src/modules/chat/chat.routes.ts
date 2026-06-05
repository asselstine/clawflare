import { Hono } from "hono";
import type { AppBindings } from "../../http/app-bindings.js";
import { requireAuth } from "../../middleware/auth.js";
import type { Env } from "../../internal-types/index.js";
import type { ChatRequest } from "../../types.js";
import {
  SessionRepository,
  SessionRunRepository,
  type SessionInputEvent,
} from "../../data/index.js";
import { json, badRequest, gone, tooManyRequests, serverError, unprocessable } from "../../http/responses.js";
import type { RequestContext } from "../../http/request-context.js";
import { resolveModelForNewSession } from "../models/models.service.js";
import { logger } from "../../lib/logger.js";
import { isTimingEnabled, logTiming, timingStart } from "../../lib/timing.js";
import { runSessionRun } from "../../runtime/workflow.js";
import { seedDefaultSessionTools } from "../tools/tools.service.js";
import { createSessionTitleFromPrompt } from "../sessions/session-title.js";

export const chatRoutes = new Hono<AppBindings>();

chatRoutes.use("*", requireAuth);
chatRoutes.post("/", (c) =>
  handleChat(c.req.raw, c.env, c.get("requestContext")!, c.executionCtx)
);

// Chat Route Handler - /v1/chat
// Handles session-based chat submissions

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
 * Handle session-based chat submission
 * Returns session handle immediately; workflow processes async
 */
export async function handleChat(
  request: Request,
  env: Env,
  requestContext: RequestContext,
  executionCtx?: ExecutionContext,
): Promise<Response> {
  let sessionIdVar: string | undefined;
  const routeStart = timingStart();
  const apiRequestId = crypto.randomUUID();
  const workspaceId = requestContext.workspace.id;

  logTiming(env, undefined, "chat.route.start", undefined, {
    workspaceId,
    apiRequestId,
    hasAuthContext: Boolean(requestContext.user.id),
  });

  try {
    const parseStart = timingStart();
    const body = (await request.json()) as ChatRequest;
    logTiming(env, body.sessionId, "chat.request.parsed", parseStart, {
      workspaceId,
      apiRequestId,
      hasSessionId: Boolean(body.sessionId),
      hasModelId: body.modelId !== undefined,
      contentLength: typeof body.content === "string" ? body.content.length : undefined,
    });

    const content = body.content;
    if (!content) {
      return badRequest("Invalid request. content is required");
    }

    const maxTurns = body.maxTurns;
    const sessionId = body.sessionId ?? crypto.randomUUID();
    sessionIdVar = sessionId;

    const sessions = new SessionRepository(env.DB);
    const lookupStart = timingStart();
    const existingSession = body.sessionId
      ? await sessions.findByIdInWorkspace(workspaceId, body.sessionId)
      : null;
    logTiming(env, sessionId, "chat.session.lookup", lookupStart, {
      workspaceId,
      apiRequestId,
      requestedExistingSession: Boolean(body.sessionId),
      found: Boolean(existingSession),
    });

    let response: Response;
    if (existingSession) {
      // Check if trying to change model on existing session
      if (body.modelId !== undefined) {
        if (body.modelId !== existingSession.modelId) {
          return badRequest(
            "Cannot change model for existing session. Create a new session instead."
          );
        }
      }
      response = await handleExistingSession(env, sessionId, workspaceId, content, maxTurns, existingSession, executionCtx, {
        apiReceivedAt: routeStart,
        apiRequestId,
      });
    } else {
      response = await handleNewSession(
        env,
        sessionId,
        workspaceId,
        content,
        maxTurns,
        body.modelId,
        requestContext,
        executionCtx,
        {
          apiReceivedAt: routeStart,
          apiRequestId,
        },
      );
    }

    logTiming(env, sessionId, "chat.route.response", routeStart, {
      workspaceId,
      apiRequestId,
      status: response.status,
      responseBytes: response.headers.get("content-length") ?? undefined,
    });
    return response;
  } catch (error) {
    logger.error("Chat request failed", error, {
      handler: "handleChat",
      route: "POST /v1/chat",
      sessionId: sessionIdVar,
      workspaceId: requestContext.workspace.id,
    });
    return serverError(error instanceof Error ? error.message : "Unknown error");
  }
}

/**
 * Handle chat for an existing session
 */
async function handleExistingSession(
  env: Env,
  sessionId: string,
  workspaceId: string,
  content: string,
  maxTurns: number | undefined,
  existingSession: import("../../data/index.js").SessionMetadataState,
  executionCtx: ExecutionContext | undefined,
  apiTiming: { apiReceivedAt: number; apiRequestId: string },
): Promise<Response> {
  const sessions = new SessionRepository(env.DB);

  if (existingSession.status === "closed" || existingSession.status === "expired") {
    return gone("Session closed. Create a new session to continue.");
  }

  if (existingSession.status === "processing") {
    return tooManyRequests("Session is already processing a prompt", {
      status: existingSession.status,
    });
  }

  const runId = crypto.randomUUID();

  // Mark session as processing BEFORE returning
  existingSession.status = "processing";
  existingSession.workflowId = runId;
  existingSession.updatedAt = Date.now();
  const processingStart = timingStart();
  await sessions.markProcessing(sessionId, runId);
  logTiming(env, sessionId, "chat.session.processing_saved", processingStart, {
    workspaceId,
    apiRequestId: apiTiming.apiRequestId,
    apiElapsedMs: Date.now() - apiTiming.apiReceivedAt,
  });

  const inputEvent: SessionInputEvent = {
    type: "prompt",
    content,
    maxTurns,
    apiReceivedAt: apiTiming.apiReceivedAt,
    apiRequestId: apiTiming.apiRequestId,
  };

  const runStart = timingStart();
  const runs = new SessionRunRepository(env.DB);
  await runs.create({ id: runId, sessionId, workspaceId, input: inputEvent });
  executionCtx?.waitUntil(runSessionRun(env, runId, { ctx: executionCtx }));
  logTiming(env, sessionId, "chat.session_run.created", runStart, {
    workspaceId,
    runId,
    apiRequestId: apiTiming.apiRequestId,
    apiElapsedMs: Date.now() - apiTiming.apiReceivedAt,
    inputType: inputEvent.type,
  });

  // Reuse the cursor already stored on session metadata. Immediately after prompt submission,
  // the client should poll from the cursor it had before this turn; re-querying latestCursor
  // adds a D1 read to the submit hot path without improving correctness.
  logTiming(env, sessionId, "chat.event_cursor.reused", undefined, {
    workspaceId,
    apiRequestId: apiTiming.apiRequestId,
    apiElapsedMs: Date.now() - apiTiming.apiReceivedAt,
  });

  const response = {
    sessionId,
    workspaceId,
    eventCursor: existingSession.nextEventCursor,
    isNewSession: false,
  };

  logChatResponseSize(env, sessionId, response, { workspaceId, isNewSession: false });
  return json(response);
}

/**
 * Handle chat for a new session
 */
async function handleNewSession(
  env: Env,
  sessionId: string,
  workspaceId: string,
  content: string,
  maxTurns: number | undefined,
  modelId: string | undefined,
  requestContext: RequestContext,
  executionCtx: ExecutionContext | undefined,
  apiTiming: { apiReceivedAt: number; apiRequestId: string },
): Promise<Response> {
  const sessions = new SessionRepository(env.DB);

  // Create authorization context for this request
  const auth = createAuthSession(requestContext);
  logTiming(env, sessionId, "chat.auth.context_created", undefined, {
    workspaceId,
    apiRequestId: apiTiming.apiRequestId,
    apiElapsedMs: Date.now() - apiTiming.apiReceivedAt,
  });

  // Resolve model for the new session
  const modelStart = timingStart();
  const resolvedModel = await resolveModelForNewSession(
    env,
    workspaceId,
    modelId,
    auth
  );
  logTiming(env, sessionId, "chat.model.resolved", modelStart, {
    workspaceId,
    apiRequestId: apiTiming.apiRequestId,
    apiElapsedMs: Date.now() - apiTiming.apiReceivedAt,
    requestedModelId: modelId,
    found: Boolean(resolvedModel),
    provider: resolvedModel?.provider,
    modelName: resolvedModel?.modelName,
  });

  // If no model is configured, return 422 error immediately
  if (!resolvedModel) {
    return unprocessable(
      "No model configured for this workspace",
      {
        hint: "Use 'clawflare providers add' to add a model provider, then '/models' in the TUI to select it",
      }
    );
  }

  // If explicit model requested but not found, return error
  if (modelId && !resolvedModel) {
    return badRequest(
      `Model "${modelId}" not found or not configured`
    );
  }

  const runId = crypto.randomUUID();
  const sessionName = createSessionTitleFromPrompt(content);

  // Initialize session state with workspace and model info
  const initialState: import("../../data/index.js").SessionMetadataState = {
    id: sessionId,
    workspaceId,
    workflowId: runId,
    name: sessionName,
    status: "processing" as const,
    nextEventCursor: "0",
    updatedAt: Date.now(),
    maxQueueSize: 100,
    idleTimeout: "7 days",
    modelId: resolvedModel?.id,
  };
  const saveStart = timingStart();
  await sessions.save(initialState);
  await seedDefaultSessionTools(env, sessionId);
  logTiming(env, sessionId, "chat.session.created", saveStart, {
    workspaceId,
    runId,
    apiRequestId: apiTiming.apiRequestId,
    apiElapsedMs: Date.now() - apiTiming.apiReceivedAt,
  });

  const inputEvent: SessionInputEvent = {
    type: "prompt",
    content,
    maxTurns,
    apiReceivedAt: apiTiming.apiReceivedAt,
    apiRequestId: apiTiming.apiRequestId,
  };

  const runStart = timingStart();
  const runs = new SessionRunRepository(env.DB);
  await runs.create({ id: runId, sessionId, workspaceId, input: inputEvent });
  executionCtx?.waitUntil(runSessionRun(env, runId, { ctx: executionCtx }));
  logTiming(env, sessionId, "chat.session_run.created", runStart, {
    workspaceId,
    runId,
    apiRequestId: apiTiming.apiRequestId,
    apiElapsedMs: Date.now() - apiTiming.apiReceivedAt,
  });

  const response: {
    sessionId: string;
    workspaceId: string;
    eventCursor: string;
    isNewSession: true;
    name?: string;
    model?: { id: string; provider: string; modelName: string };
  } = {
    sessionId,
    workspaceId,
    eventCursor: initialState.nextEventCursor,
    isNewSession: true,
    name: sessionName,
  };

  // Include model info if available
  if (resolvedModel) {
    response.model = {
      id: resolvedModel.id,
      provider: resolvedModel.provider,
      modelName: resolvedModel.modelName,
    };
  }

  logChatResponseSize(env, sessionId, response, { workspaceId, isNewSession: true });
  return json(response);
}

function logChatResponseSize(
  env: Env,
  sessionId: string,
  response: unknown,
  details: Record<string, unknown>,
): void {
  if (!isTimingEnabled(env)) return;

  logTiming(env, sessionId, "chat.response.serialized", undefined, {
    ...details,
    responseBytes: JSON.stringify(response).length,
  });
}
