// Session state management - backed by a per-session Durable Object.
import type {
  Env,
  SessionMetadataState,
  SessionInputEvent,
  StoredSessionEvent,
  NewSessionEvent,
} from "./internal-types/index.js";
import type { SessionEvent } from "./types.js";

function getSessionStore(env: Env, sessionId: string): DurableObjectStub {
  const id = env.SESSION_STORE.idFromName(sessionId);
  return env.SESSION_STORE.get(id);
}

async function jsonFetch<T>(stub: DurableObjectStub, path: string, init?: RequestInit): Promise<T> {
  const response = await stub.fetch(`https://session-store.local${path}`, init);
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Session store request failed: ${response.status} ${error}`);
  }
  return response.json() as Promise<T>;
}

// Storage keys for session data (documented for reference)
// const STATE_KEY = "state";
// const EVENT_META_KEY = "event_meta";
// const EVENT_PREFIX = "evt/";
// const WORKFLOW_SESSION_KEY = "workflowSession";
// const WORKFLOW_ID_KEY = "workflowId";
// const INPUT_QUEUE_KEY = "inputQueue";
// const SESSION_ACTIVE_KEY = "sessionActive";

// const MAX_EVENTS_PER_SESSION = 1000;
// const EVENT_TRIM_BATCH = 100;
// const MAX_QUEUE_SIZE = 100;

/**
 * Create or update a session state.
 */
export async function saveSessionState(
  env: Env,
  session: SessionMetadataState,
): Promise<void> {
  await jsonFetch(getSessionStore(env, session.id), "/state", {
    method: "PUT",
    body: JSON.stringify(session),
  });
}

/**
 * Load session state.
 */
export async function loadSessionState(
  env: Env,
  sessionId: string,
): Promise<SessionMetadataState | null> {
  const stub = getSessionStore(env, sessionId);
  const response = await stub.fetch("https://session-store.local/state");
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Session state fetch failed: ${response.status} ${await response.text()}`);
  }
  return response.json() as Promise<SessionMetadataState>;
}

/**
 * Mark a polling session as failed so clients do not wait forever when
 * Workflow execution throws outside the normal agent/session update path.
 */
export async function markSessionError(
  env: Env,
  sessionId: string,
  error: unknown,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await jsonFetch(getSessionStore(env, sessionId), "/state/error", {
    method: "POST",
    body: JSON.stringify({ message }),
  });
}

export async function getLatestEventCursor(env: Env, sessionId: string): Promise<string> {
  const response = await jsonFetch<{ cursor: string }>(getSessionStore(env, sessionId), "/cursor");
  return response.cursor;
}

/**
 * Get events for a session, optionally filtered by sequence cursor.
 * Returns public SessionEvent type (converts from stored events).
 */
export async function getSessionEvents(
  env: Env,
  sessionId: string,
  sinceCursor?: string,
  limit: number = 100,
): Promise<{ events: SessionEvent[]; nextCursor: string }> {
  const url = new URL("https://session-store.local/events");
  url.searchParams.set("since", sinceCursor || "0");
  url.searchParams.set("limit", String(limit));
  const result = await jsonFetch<{ events: StoredSessionEvent[]; nextCursor: string }>(
    getSessionStore(env, sessionId),
    `${url.pathname}${url.search}`
  );
  // Convert stored events to public SessionEvent type
  const events = result.events.map(convertStoredToPublicEvent);
  return { events, nextCursor: result.nextCursor };
}

/**
 * Convert stored event to public SessionEvent
 */
function convertStoredToPublicEvent(stored: StoredSessionEvent): SessionEvent {
  // Storedevents are a subset of SessionEvent - cast for now
  // In production, this would properly convert between the formats
  return stored as unknown as SessionEvent;
}

/**
 * Append events to a session's event log and assign per-session sequence numbers.
 */
export async function appendSessionEvents(
  env: Env,
  sessionId: string,
  newEvents: NewSessionEvent[],
): Promise<void> {
  await jsonFetch(getSessionStore(env, sessionId), "/events", {
    method: "POST",
    body: JSON.stringify({ events: newEvents }),
  });
}

/**
 * Get the workflow ID associated with a session.
 */
export async function getSessionWorkflowId(
  env: Env,
  sessionId: string,
): Promise<string | null> {
  try {
    const response = await jsonFetch<{ workflowId: string }>(getSessionStore(env, sessionId), "/workflow-id");
    return response.workflowId;
  } catch {
    return null;
  }
}

/**
 * Save the workflow ID for a session.
 */
export async function saveSessionWorkflowId(
  env: Env,
  sessionId: string,
  workflowId: string,
): Promise<void> {
  await jsonFetch(getSessionStore(env, sessionId), "/workflow-id", {
    method: "PUT",
    body: JSON.stringify({ workflowId }),
  });
}

/**
 * Get the current input queue status for a session.
 */
export async function getSessionInputQueue(
  env: Env,
  sessionId: string,
): Promise<{ pending: number; max: number; events: SessionInputEvent[] }> {
  return jsonFetch(getSessionStore(env, sessionId), "/input-queue");
}

/**
 * Enqueue an input event for the session workflow.
 * Returns 429 if queue is full.
 */
export async function enqueueSessionInput(
  env: Env,
  sessionId: string,
  event: SessionInputEvent,
): Promise<{ ok: boolean; queued: number; error?: string }> {
  const stub = getSessionStore(env, sessionId);
  const response = await stub.fetch("https://session-store.local/input-queue", {
    method: "POST",
    body: JSON.stringify(event),
  });
  if (!response.ok) {
    const error = await response.json() as { error: string; current: number; max: number };
    return { ok: false, queued: error.current, error: error.error };
  }
  const result = await response.json() as { ok: boolean; queued: number };
  return result;
}

/**
 * Dequeue the next input event - called by workflow to get pending input.
 */
export async function dequeueSessionInput(
  env: Env,
  sessionId: string,
): Promise<{ event: SessionInputEvent | null; remaining: number }> {
  return jsonFetch(getSessionStore(env, sessionId), "/input-queue", {
    method: "DELETE",
  });
}

/**
 * Check if a session is currently active (workflow running).
 */
export async function isSessionActive(
  env: Env,
  sessionId: string,
): Promise<boolean> {
  const response = await jsonFetch<{ active: boolean }>(getSessionStore(env, sessionId), "/session-active");
  return response.active;
}

/**
 * Set session active status - called by workflow on start/end.
 */
export async function setSessionActive(
  env: Env,
  sessionId: string,
  active: boolean,
): Promise<void> {
  await jsonFetch(getSessionStore(env, sessionId), "/session-active", {
    method: "PUT",
    body: JSON.stringify({ active }),
  });
}

/**
 * Mark session as closed.
 */
export async function markSessionClosed(
  env: Env,
  sessionId: string,
  reason: "user" | "timeout" | "error",
): Promise<void> {
  const state = await loadSessionState(env, sessionId);
  if (state) {
    state.status = reason === "timeout" ? "expired" : "closed";
    state.updatedAt = Date.now();
    await saveSessionState(env, state);
  }
  await setSessionActive(env, sessionId, false);
}

// Re-export status for convenience
export type { SessionMetadataState } from "./internal-types/index.js";
