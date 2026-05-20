// State management helpers for Workflow-Agent decoupling.
import type { AgentSessionState } from "./agent";
import type { Env } from "./types";

export function sessionKey(sessionId: string): string {
  return `session:${sessionId}`;
}

function getSessionStore(env: Env, sessionId: string): DurableObjectStub {
  const id = env.SESSION_STORE.idFromName(sessionId);
  return env.SESSION_STORE.get(id);
}

async function jsonFetch<T>(stub: DurableObjectStub, path: string, init?: RequestInit): Promise<T> {
  const response = await stub.fetch(`https://session-store.local${path}`, init);
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Workflow session store request failed: ${response.status} ${error}`);
  }
  return response.json() as Promise<T>;
}

export async function loadSession(env: Env, sessionId: string): Promise<AgentSessionState> {
  return jsonFetch(getSessionStore(env, sessionId), "/workflow-session");
}

export async function saveSession(env: Env, session: AgentSessionState): Promise<void> {
  await jsonFetch(getSessionStore(env, session.id), "/workflow-session", {
    method: "PUT",
    body: JSON.stringify({
      ...session,
      updatedAt: Date.now(),
    }),
  });
}
