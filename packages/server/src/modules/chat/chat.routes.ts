import { Hono } from "hono";
import type { AppBindings } from "../../http/app-bindings.js";
import { requireAuth } from "../../middleware/auth.js";
import type { Env } from "../../internal-types/index.js";
import type { ChatRequest, ModelProvider } from "../../types.js";
import {
  SessionRepository,
  SessionRuntimeRepository,
  type SessionInputEvent,
} from "../../data/index.js";
import { json, badRequest, gone, tooManyRequests, serverError, unprocessable } from "../../http/responses.js";
import type { RequestContext } from "../../http/request-context.js";
import { resolveModelConnectionForNewSession } from "../model-connections/model-connections.service.js";
import { logger } from "../../lib/logger.js";
import { isTimingEnabled, logTiming, timingStart } from "../../lib/timing.js";
import { createWorkflowInstance, withWorkflowInstance } from "../../runtime/workflow-handles.js";
import { seedDefaultSessionTools } from "../tools/tools.service.js";

export const chatRoutes = new Hono<AppBindings>();

const WORKFLOW_PREWARM_WAIT_MS = 2500;
const WORKFLOW_PREWARM_RETRY_MS = 100;

chatRoutes.use("*", requireAuth);
chatRoutes.post("/", (c) =>
  handleChat(c.req.raw, c.env, c.get("requestContext")!)
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendPromptToPrewarmedWorkflow(
  env: Env,
  workflowId: string,
  inputEvent: SessionInputEvent,
): Promise<void> {
  const deadline = Date.now() + WORKFLOW_PREWARM_WAIT_MS;
  let lastError: unknown;

  while (Date.now() <= deadline) {
    try {
      await withWorkflowInstance(env.AGENT_WORKFLOW, workflowId, (workflowInstance) => {
        return workflowInstance.sendEvent({
          type: "session-input",
          payload: inputEvent,
        });
      });
      return;
    } catch (error) {
      lastError = error;
      await sleep(WORKFLOW_PREWARM_RETRY_MS);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Prewarmed workflow was not ready before the retry timeout");
}

/**
 * Handle session-based chat submission
 * Returns session handle immediately; workflow processes async
 */
export async function handleChat(
  request: Request,
  env: Env,
  requestContext: RequestContext
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
      hasModelConnectionId: body.modelConnectionId !== undefined,
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
      if (body.modelConnectionId !== undefined) {
        if (body.modelConnectionId !== existingSession.modelConnectionId) {
          return badRequest(
            "Cannot change model connection for existing session. Create a new session instead."
          );
        }
      }
      response = await handleExistingSession(env, sessionId, workspaceId, content, maxTurns, existingSession, {
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
        body.modelConnectionId,
        requestContext,
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
  apiTiming: { apiReceivedAt: number; apiRequestId: string },
): Promise<Response> {
  const sessions = new SessionRepository(env.DB);
  const runtime = new SessionRuntimeRepository(env.DB);

  if (existingSession.status === "closed" || existingSession.status === "expired") {
    return gone("Session closed. Create a new session to continue.");
  }

  if (existingSession.status === "processing") {
    return tooManyRequests("Session is already processing a prompt", {
      status: existingSession.status,
    });
  }

  let workflowId = existingSession.workflowId;
  let needsWorkflowCreate = !workflowId;
  if (workflowId) {
    const waitingAt = await runtime.getWorkflowWaitingAt(sessionId);
    if (waitingAt === null) {
      workflowId = crypto.randomUUID();
      needsWorkflowCreate = true;
      logTiming(env, sessionId, "chat.workflow.prewarm_not_ready", undefined, {
        workspaceId,
        previousWorkflowId: existingSession.workflowId,
        workflowId,
        apiRequestId: apiTiming.apiRequestId,
        apiElapsedMs: Date.now() - apiTiming.apiReceivedAt,
      });
    }
  } else {
    workflowId = crypto.randomUUID();
  }

  // Mark session as processing BEFORE returning
  existingSession.status = "processing";
  existingSession.workflowId = workflowId;
  existingSession.updatedAt = Date.now();
  const processingStart = timingStart();
  await sessions.markProcessing(sessionId, workflowId);
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

  if (needsWorkflowCreate) {
    const createStart = timingStart();
    await createWorkflowInstance(env.AGENT_WORKFLOW, {
      id: workflowId,
      params: { sessionId, initialInput: inputEvent },
    });
    logTiming(env, sessionId, "chat.workflow.created", createStart, {
      workspaceId,
      workflowId,
      apiRequestId: apiTiming.apiRequestId,
      apiElapsedMs: Date.now() - apiTiming.apiReceivedAt,
      inputType: inputEvent.type,
      deferredFromSessionCreate: true,
    });
  } else {
    // First prompt usually lands here after /v1/session has prewarmed the workflow in waitUntil.
    // Retrying briefly smooths over the race where the user submits before that prewarm finishes.
    const eventStart = timingStart();
    await sendPromptToPrewarmedWorkflow(env, workflowId, inputEvent);
    logTiming(env, sessionId, "chat.workflow.input_sent", eventStart, {
      workspaceId,
      workflowId,
      apiRequestId: apiTiming.apiRequestId,
      apiElapsedMs: Date.now() - apiTiming.apiReceivedAt,
      inputType: inputEvent.type,
    });
  }

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
  modelConnectionId: string | undefined,
  requestContext: RequestContext,
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

  // Resolve model connection for the new session
  const modelStart = timingStart();
  const resolvedModel = await resolveModelConnectionForNewSession(
    env,
    workspaceId,
    modelConnectionId,
    auth
  );
  logTiming(env, sessionId, "chat.model.resolved", modelStart, {
    workspaceId,
    apiRequestId: apiTiming.apiRequestId,
    apiElapsedMs: Date.now() - apiTiming.apiReceivedAt,
    requestedModelConnectionId: modelConnectionId,
    found: Boolean(resolvedModel),
    provider: resolvedModel?.provider,
    modelName: resolvedModel?.modelName,
  });

  // If no model connection is configured, return 422 error immediately
  if (!resolvedModel) {
    return unprocessable(
      "No model connection configured for this workspace",
      {
        hint: "Use 'clawflare providers add' to add a model provider, then '/models' in the TUI to select it",
      }
    );
  }

  // If explicit model requested but not found, return error
  if (modelConnectionId && !resolvedModel) {
    return badRequest(
      `Model connection "${modelConnectionId}" not found or not configured`
    );
  }

  const workflowId = crypto.randomUUID();

  // Initialize session state with workspace and model info
  const initialState: import("../../data/index.js").SessionMetadataState = {
    id: sessionId,
    workspaceId,
    workflowId,
    status: "processing" as const,
    nextEventCursor: "0",
    updatedAt: Date.now(),
    maxQueueSize: 100,
    idleTimeout: "7 days",
    modelConnectionId: resolvedModel?.id,
    modelProvider: (resolvedModel?.provider as ModelProvider | undefined),
    modelName: resolvedModel?.modelName,
  };
  const saveStart = timingStart();
  await sessions.save(initialState);
  await seedDefaultSessionTools(env, sessionId);
  logTiming(env, sessionId, "chat.session.created", saveStart, {
    workspaceId,
    workflowId,
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

  // Create persistent workflow with the initial prompt attached.
  const createStart = timingStart();
  await createWorkflowInstance(env.AGENT_WORKFLOW, {
    id: workflowId,
    params: { sessionId, initialInput: inputEvent },
  });
  logTiming(env, sessionId, "chat.workflow.created", createStart, {
    workspaceId,
    workflowId,
    apiRequestId: apiTiming.apiRequestId,
    apiElapsedMs: Date.now() - apiTiming.apiReceivedAt,
  });

  const response: {
    sessionId: string;
    workspaceId: string;
    eventCursor: string;
    isNewSession: true;
    modelConnection?: { id: string; provider: string; modelName: string };
  } = {
    sessionId,
    workspaceId,
    eventCursor: initialState.nextEventCursor,
    isNewSession: true,
  };

  // Include model connection info if available
  if (resolvedModel) {
    response.modelConnection = {
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
