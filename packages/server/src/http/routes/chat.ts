// Chat Route Handler - /v1/chat
// Handles session-based chat submissions

import type { Env } from "../../internal-types/index.js";
import type { ChatRequest } from "../../types.js";
import type { SessionInputEvent, SessionMetadataState } from "../../data/index.js";
import { json, badRequest, gone, tooManyRequests, serverError } from "../responses.js";
import { timingStart, logTiming } from "../../diagnostics.js";
import { getDataLayer } from "../../data/index.js";

/**
 * Handle session-based chat submission
 * Returns session handle immediately; workflow processes async
 */
export async function handleChat(request: Request, env: Env): Promise<Response> {
  const requestStart = timingStart();
  let sessionIdVar: string | undefined;

  try {
    const body = (await request.json()) as ChatRequest;

    const content = body.content;
    if (body.type !== "prompt" || !content) {
      return badRequest("Invalid request. type='prompt' and content required");
    }

    const maxTurns = body.maxTurns;
    sessionIdVar = body.sessionId || crypto.randomUUID();
    const sessionId: string = sessionIdVar;

    logTiming(env, sessionId, "chat.request.parsed", requestStart, {
      hasExistingSession: Boolean(body.sessionId),
      promptLength: content.length,
      action: body.sessionId ? "sendEvent" : "createWorkflow",
    });

    const data = getDataLayer(env);
    const existingSession = body.sessionId ? await data.sessions.findById(body.sessionId) : null;

    if (existingSession) {
      return handleExistingSession(env, sessionId, content, maxTurns, existingSession, requestStart);
    } else {
      return handleNewSession(env, sessionId, content, maxTurns, requestStart);
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
  content: string,
  maxTurns: number | undefined,
  existingSession: SessionMetadataState,
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
  content: string,
  maxTurns: number | undefined,
  requestStart: number
): Promise<Response> {
  logTiming(env, sessionId, "chat.workflow.create.start", requestStart);
  const data = getDataLayer(env);

  const initialEventCursor = await data.events.latestCursor(sessionId);
  const workflowId = crypto.randomUUID();

  // Initialize session state
  const initialState = {
    id: sessionId,
    workflowId,
    status: "processing" as const,
    nextEventCursor: initialEventCursor,
    updatedAt: Date.now(),
    maxQueueSize: 100,
    idleTimeout: "7 days",
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

  const response = {
    sessionId,
    eventCursor: initialState.nextEventCursor,
    isNewSession: true,
  };

  logTiming(env, sessionId, "chat.response.returning", requestStart);
  return json(response);
}
