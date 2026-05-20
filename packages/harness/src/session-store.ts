// Session state management - backed by D1
// This module provides a lightweight facade over the D1 data layer
// Queue operations optionally go through the Session Coordinator for concurrency safety

import type {
  Env,
  SessionMetadataState,
  SessionInputEvent,
  NewSessionEvent,
} from "./internal-types/index.js";
import type { SessionEvent } from "./types.js";
import { createDataLayer } from "./data/index.js";
import {
  coordinatorEnqueueSessionInput,
  coordinatorDequeueSessionInput,
  coordinatorAppendSessionEvents as coordinatorAppendEvents,
} from "./session-coordinator.js";

// Cached data layer per environment to avoid recreating
const dataLayerCache = new WeakMap<Env, ReturnType<typeof createDataLayer>>();

function getDataLayer(env: Env) {
  let layer = dataLayerCache.get(env);
  if (!layer) {
    layer = createDataLayer(env);
    dataLayerCache.set(env, layer);
  }
  return layer;
}

/**
 * Check if coordinator-based concurrency control should be used.
 * Uses coordinator when SESSION_COORDINATOR binding is available.
 */
function useCoordinator(env: Env): boolean {
  return Boolean((env as unknown as { SESSION_COORDINATOR?: DurableObjectNamespace }).SESSION_COORDINATOR);
}

/**
 * Create or update a session state.
 */
export async function saveSessionState(
  env: Env,
  session: SessionMetadataState,
): Promise<void> {
  await getDataLayer(env).sessions.save(session);
}

/**
 * Load session state.
 */
export async function loadSessionState(
  env: Env,
  sessionId: string,
): Promise<SessionMetadataState | null> {
  return getDataLayer(env).sessions.findById(sessionId);
}

/**
 * Mark a polling session as failed.
 */
export async function markSessionError(
  env: Env,
  sessionId: string,
  error: unknown,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await getDataLayer(env).sessions.markError(sessionId, message);
}

/**
 * Get the latest event cursor for a session.
 */
export async function getLatestEventCursor(env: Env, sessionId: string): Promise<string> {
  return getDataLayer(env).events.latestCursor(sessionId);
}

/**
 * Get events for a session, optionally filtered by sequence cursor.
 */
export async function getSessionEvents(
  env: Env,
  sessionId: string,
  sinceCursor?: string,
  limit: number = 100,
): Promise<{ events: SessionEvent[]; nextCursor: string }> {
  return getDataLayer(env).events.listSince(sessionId, sinceCursor, limit);
}

/**
 * Append events to a session's event log.
 * Goes through coordinator if available for concurrency safety.
 */
export async function appendSessionEvents(
  env: Env,
  sessionId: string,
  newEvents: NewSessionEvent[],
): Promise<void> {
  if (useCoordinator(env)) {
    await coordinatorAppendEvents(env, sessionId, newEvents);
  } else {
    await getDataLayer(env).events.append(sessionId, newEvents);
  }
}

/**
 * Get the workflow ID associated with a session.
 */
export async function getSessionWorkflowId(
  env: Env,
  sessionId: string,
): Promise<string | null> {
  return getDataLayer(env).runtime.getWorkflowId(sessionId);
}

/**
 * Save the workflow ID for a session.
 */
export async function saveSessionWorkflowId(
  env: Env,
  sessionId: string,
  workflowId: string,
): Promise<void> {
  await getDataLayer(env).runtime.saveWorkflowId(sessionId, workflowId);
}

/**
 * Get the current input queue status for a session.
 */
export async function getSessionInputQueue(
  env: Env,
  sessionId: string,
): Promise<{ pending: number; max: number; events: SessionInputEvent[] }> {
  return getDataLayer(env).inputQueue.status(sessionId);
}

/**
 * Enqueue an input event for the session workflow.
 * Goes through coordinator if available for concurrency safety.
 */
export async function enqueueSessionInput(
  env: Env,
  sessionId: string,
  event: SessionInputEvent,
): Promise<{ ok: boolean; queued: number; error?: string }> {
  if (useCoordinator(env)) {
    return coordinatorEnqueueSessionInput(env, sessionId, event);
  }
  return getDataLayer(env).inputQueue.enqueue(sessionId, event);
}

/**
 * Dequeue the next input event - called by workflow to get pending input.
 * Goes through coordinator if available for concurrency safety.
 */
export async function dequeueSessionInput(
  env: Env,
  sessionId: string,
): Promise<{ event: SessionInputEvent | null; remaining: number }> {
  if (useCoordinator(env)) {
    return coordinatorDequeueSessionInput(env, sessionId);
  }
  return getDataLayer(env).inputQueue.dequeue(sessionId);
}

/**
 * Check if a session is currently active (workflow running).
 */
export async function isSessionActive(
  env: Env,
  sessionId: string,
): Promise<boolean> {
  return getDataLayer(env).runtime.isActive(sessionId);
}

/**
 * Set session active status - called by workflow on start/end.
 */
export async function setSessionActive(
  env: Env,
  sessionId: string,
  active: boolean,
): Promise<void> {
  await getDataLayer(env).runtime.setActive(sessionId, active);
}

/**
 * Mark session as closed.
 */
export async function markSessionClosed(
  env: Env,
  sessionId: string,
  reason: "user" | "timeout" | "error",
): Promise<void> {
  const layer = getDataLayer(env);
  await layer.sessions.markClosed(sessionId, reason);
  await layer.runtime.setActive(sessionId, false);
}

// Re-export status for convenience
export type { SessionMetadataState } from "./internal-types/index.js";
