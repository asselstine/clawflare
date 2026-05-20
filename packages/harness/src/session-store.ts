// Session state management - backed by a per-session Durable Object.
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { SessionEvent, SessionState } from "./types";
import type { Env } from "./types";

type NewSessionEvent = AgentEvent & { timestamp: number };

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

/**
 * Create or update a session state.
 */
export async function saveSessionState(
  env: Env,
  session: SessionState,
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
): Promise<SessionState | null> {
  const stub = getSessionStore(env, sessionId);
  const response = await stub.fetch("https://session-store.local/state");
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Session state fetch failed: ${response.status} ${await response.text()}`);
  }
  return response.json() as Promise<SessionState>;
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
  return jsonFetch(getSessionStore(env, sessionId), `${url.pathname}${url.search}`);
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
