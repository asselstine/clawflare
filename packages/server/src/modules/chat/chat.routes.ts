import { Hono } from "hono";
import type { AppBindings } from "../../http/app-bindings.js";
import { requireAuth } from "../../middleware/auth.js";
import type { Env } from "../../internal-types/index.js";
import type { ChatRequest, ModelProvider } from "../../types.js";
import {
  InputQueueRepository,
  SessionEventRepository,
  SessionRepository,
  type SessionInputEvent,
} from "../../data/index.js";
import { json, badRequest, gone, tooManyRequests, serverError, unprocessable } from "../../http/responses.js";
import type { RequestContext } from "../../http/request-context.js";
import { resolveModelConnectionForNewSession } from "../model-connections/model-connections.service.js";
import { logger } from "../../lib/logger.js";

export const chatRoutes = new Hono<AppBindings>();

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

  try {
    const body = (await request.json()) as ChatRequest;

    const content = body.content;
    if (!content) {
      return badRequest("Invalid request. content is required");
    }

    const maxTurns = body.maxTurns;
    const sessionId = body.sessionId ?? crypto.randomUUID();
    sessionIdVar = sessionId;
    const workspaceId = requestContext.workspace.id;

    const sessions = new SessionRepository(env.DB);
    const existingSession = body.sessionId
      ? await sessions.findByIdInWorkspace(workspaceId, body.sessionId)
      : null;

    if (existingSession) {
      // Check if trying to change model on existing session
      if (body.modelConnectionId !== undefined) {
        if (body.modelConnectionId !== existingSession.modelConnectionId) {
          return badRequest(
            "Cannot change model connection for existing session. Create a new session instead."
          );
        }
      }
      return handleExistingSession(env, sessionId, workspaceId, content, maxTurns, existingSession);
    } else {
      return handleNewSession(
        env,
        sessionId,
        workspaceId,
        content,
        maxTurns,
        body.modelConnectionId,
        requestContext
      );
    }
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
  existingSession: import("../../data/index.js").SessionMetadataState
): Promise<Response> {
  const sessions = new SessionRepository(env.DB);
  const inputQueue = new InputQueueRepository(env.DB);
  const events = new SessionEventRepository(env.DB);

  if (existingSession.status === "closed" || existingSession.status === "expired") {
    return gone("Session closed. Create a new session to continue.");
  }

  const workflowId = existingSession.workflowId;
  if (!workflowId) {
    return serverError("Session has no associated workflow");
  }

  // Mark session as processing BEFORE returning
  existingSession.status = "processing";
  existingSession.updatedAt = Date.now();
  await sessions.save(existingSession);

  // Queue the event first (for ordering guarantees)
  const enqueueResult = await inputQueue.enqueue(sessionId, {
    type: "prompt",
    content,
    maxTurns,
  } as SessionInputEvent);

  if (!enqueueResult.ok) {
    return tooManyRequests(enqueueResult.error || "Queue full", {
      queued: enqueueResult.queued,
    });
  }

  // Send a wake event to trigger the workflow to consume the durable queue
  const workflowInstance = await env.AGENT_WORKFLOW.get(workflowId);
  await workflowInstance.sendEvent({
    type: "session-input",
    payload: { type: "wake" },
  });

  // Get fresh event cursor
  const freshEventCursor = await events.latestCursor(sessionId);

  const response = {
    sessionId,
    workspaceId,
    eventCursor: freshEventCursor,
    isNewSession: false,
  };

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
  requestContext: RequestContext
): Promise<Response> {
  const sessions = new SessionRepository(env.DB);
  const inputQueue = new InputQueueRepository(env.DB);
  const events = new SessionEventRepository(env.DB);

  // Create authorization context for this request
  const auth = createAuthSession(requestContext);

  // Resolve model connection for the new session
  const resolvedModel = await resolveModelConnectionForNewSession(
    env,
    workspaceId,
    modelConnectionId,
    auth
  );

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

  const initialEventCursor = await events.latestCursor(sessionId);
  const workflowId = crypto.randomUUID();

  // Initialize session state with workspace and model info
  const initialState: import("../../data/index.js").SessionMetadataState = {
    id: sessionId,
    workspaceId,
    workflowId,
    status: "processing" as const,
    nextEventCursor: initialEventCursor,
    updatedAt: Date.now(),
    maxQueueSize: 100,
    idleTimeout: "7 days",
    modelConnectionId: resolvedModel?.id,
    modelProvider: (resolvedModel?.provider as ModelProvider | undefined),
    modelName: resolvedModel?.modelName,
  };
  await sessions.save(initialState);

  // Queue the event before creating/waking the workflow
  await inputQueue.enqueue(sessionId, {
    type: "prompt",
    content,
    maxTurns,
  } as SessionInputEvent);

  // Create persistent workflow after the initial input is queued
  await env.AGENT_WORKFLOW.create({
    id: workflowId,
    params: { sessionId },
  });

  // Get workflow instance and wake it to consume the queued prompt
  const workflowInstance = await env.AGENT_WORKFLOW.get(workflowId);
  await workflowInstance.sendEvent({
    type: "session-input",
    payload: { type: "wake" },
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

  return json(response);
}
