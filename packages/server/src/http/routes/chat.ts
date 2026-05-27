// Chat Route Handler - /v1/chat
// Handles session-based chat submissions

import type { Env } from "../../internal-types/index.js";
import type { ChatRequest, ModelProvider } from "../../types.js";
import type { SessionInputEvent } from "../../data/index.js";
import { json, badRequest, gone, tooManyRequests, serverError, unprocessable } from "../responses.js";
import { timingStart, logTiming } from "../../diagnostics.js";
import { getDataLayer } from "../../data/index.js";
import type { RequestContext } from "../request-context.js";
import { resolveModelConnectionForNewSession } from "../../model-connection-service.js";

/**
 * Handle session-based chat submission
 * Returns session handle immediately; workflow processes async
 */
export async function handleChat(
  request: Request,
  env: Env,
  requestContext: RequestContext
): Promise<Response> {
  const requestStart = timingStart();
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

    logTiming(env, sessionId, "chat.request.parsed", requestStart, {
      hasExistingSession: Boolean(body.sessionId),
      promptLength: content.length,
      action: body.sessionId ? "sendEvent" : "createWorkflow",
      workspaceId,
    });

    const data = getDataLayer(env);
    const existingSession = body.sessionId
      ? await data.sessions.findByIdInWorkspace(workspaceId, body.sessionId)
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
      return handleExistingSession(env, sessionId, workspaceId, content, maxTurns, existingSession, requestStart);
    } else {
      return handleNewSession(
        env,
        sessionId,
        workspaceId,
        content,
        maxTurns,
        body.modelConnectionId,
        requestStart
      );
    }
  } catch (error) {
    logTiming(env, sessionIdVar, "chat.request.error", requestStart, {
      error: error instanceof Error ? error.message : String(error),
    });
    console.error("[handleChat] Error:", error);
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
  requestStart: number
): Promise<Response> {
  logTiming(env, sessionId, "chat.sendEvent.start", requestStart);
  const data = getDataLayer(env);

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
  await data.sessions.save(existingSession);
  logTiming(env, sessionId, "chat.session.processing_marked", requestStart);

  // Queue the event first (for ordering guarantees)
  const enqueueResult = await data.inputQueue.enqueue(sessionId, {
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
  const eventStart = timingStart();
  const workflowInstance = await env.AGENT_WORKFLOW.get(workflowId);
  await workflowInstance.sendEvent({
    type: "session-input",
    payload: { type: "wake" },
  });
  logTiming(env, sessionId, "chat.sendEvent.done", eventStart);

  // Get fresh event cursor
  const freshEventCursor = await data.events.latestCursor(sessionId);
  logTiming(env, sessionId, "chat.event_cursor.fresh", requestStart);

  const response = {
    sessionId,
    workspaceId,
    eventCursor: freshEventCursor,
    isNewSession: false,
  };

  logTiming(env, sessionId, "chat.response.returning", requestStart);
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
  requestStart: number
): Promise<Response> {
  logTiming(env, sessionId, "chat.workflow.create.start", requestStart);
  const data = getDataLayer(env);

  // Resolve model connection for the new session
  const resolvedModel = await resolveModelConnectionForNewSession(
    env,
    workspaceId,
    modelConnectionId
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

  const initialEventCursor = await data.events.latestCursor(sessionId);
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
  await data.sessions.save(initialState);
  logTiming(env, sessionId, "chat.session_state.saved", requestStart);

  // Queue the event before creating/waking the workflow
  await data.inputQueue.enqueue(sessionId, {
    type: "prompt",
    content,
    maxTurns,
  } as SessionInputEvent);

  // Create persistent workflow after the initial input is queued
  await env.AGENT_WORKFLOW.create({
    id: workflowId,
    params: { sessionId },
  });
  logTiming(env, sessionId, "chat.workflow.create.done", requestStart);

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

  logTiming(env, sessionId, "chat.response.returning", requestStart);
  return json(response);
}
