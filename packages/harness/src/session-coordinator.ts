// Session Coordinator Durable Object
// Provides per-session serialization for queue operations and event appends
// This ensures concurrency safety while D1 remains the source of truth

import { DurableObject } from "cloudflare:workers";
import type { Env, SessionInputEvent } from "./internal-types/index.js";
import { createDataLayer } from "./data/index.js";
import type { NewSessionEvent } from "./data/interfaces.js";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Session Coordinator Durable Object
 * 
 * Responsibilities:
 * - Serialize enqueue/dequeue for queue concurrency safety
 * - Serialize event append operations for sequence safety
 * - Act as a wake coordination point for workflows
 * 
 * Note: No durable state is stored in this DO - D1 is the source of truth.
 * The DO only provides single-threaded coordination per session.
 */
export class ClawflareSessionCoordinator extends DurableObject<Env> {
  private coordinatorEnv: Env;

  constructor(ctx: DurableObjectState<Env>, env: Env) {
    super(ctx, env);
    this.coordinatorEnv = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, "");

    try {
      if (path === "/input-queue" && request.method === "GET") {
        return this.getInputQueue(url);
      }

      if (path === "/input-queue" && request.method === "POST") {
        return this.enqueueInput(request, url);
      }

      if (path === "/input-queue" && request.method === "DELETE") {
        return this.dequeueInput(url);
      }

      if (path === "/events" && request.method === "POST") {
        return this.appendEvents(request, url);
      }

      if (path === "/events" && request.method === "GET") {
        return this.getEvents(url);
      }

      if (path === "/cursor" && request.method === "GET") {
        return this.getLatestCursor(url);
      }

      if (path === "/wake" && request.method === "POST") {
        return this.wakeWorkflow(request);
      }

      if (path === "/debug" && request.method === "GET") {
        return this.debug(url);
      }

      return json({ error: "Not found" }, 404);
    } catch (error) {
      return json(
        { error: error instanceof Error ? error.message : String(error) },
        500
      );
    }
  }

  private getSessionId(url: URL): string {
    const sessionId = url.searchParams.get("sessionId");
    if (!sessionId) {
      throw new Error("sessionId required");
    }
    return sessionId;
  }

  private getDataLayer() {
    return createDataLayer(this.coordinatorEnv);
  }

  private async getInputQueue(url: URL): Promise<Response> {
    const sessionId = this.getSessionId(url);
    const data = this.getDataLayer();
    return json(await data.inputQueue.status(sessionId));
  }

  private async enqueueInput(request: Request, url: URL): Promise<Response> {
    const sessionId = this.getSessionId(url);
    const event = await request.json<SessionInputEvent>();
    const data = this.getDataLayer();
    const result = await data.inputQueue.enqueue(sessionId, event);
    return json(result, result.ok ? 200 : 429);
  }

  private async dequeueInput(url: URL): Promise<Response> {
    const sessionId = this.getSessionId(url);
    const data = this.getDataLayer();
    const result = await data.inputQueue.dequeue(sessionId);
    return json(result);
  }

  private async appendEvents(request: Request, url: URL): Promise<Response> {
    const sessionId = this.getSessionId(url);
    const body = await request.json<{ events: NewSessionEvent[] }>();
    const data = this.getDataLayer();
    const result = await data.events.append(sessionId, body.events);
    return json({ ok: true, ...result });
  }

  private async getEvents(url: URL): Promise<Response> {
    const sessionId = this.getSessionId(url);
    const since = url.searchParams.get("since") ?? undefined;
    const limit = parseInt(url.searchParams.get("limit") ?? "100", 10);
    const data = this.getDataLayer();
    const result = await data.events.listSince(sessionId, since, limit);
    return json(result);
  }

  private async getLatestCursor(url: URL): Promise<Response> {
    const sessionId = this.getSessionId(url);
    const data = this.getDataLayer();
    const cursor = await data.events.latestCursor(sessionId);
    return json({ cursor });
  }

  private async wakeWorkflow(request: Request): Promise<Response> {
    const body = await request.json<{ workflowId: string }>();

    if (!body.workflowId) {
      return json({ error: "workflowId required" }, 400);
    }

    const workflowInstance = await this.coordinatorEnv.AGENT_WORKFLOW.get(body.workflowId);
    await workflowInstance.sendEvent({
      type: "session-input",
      payload: { type: "wake" },
    });

    return json({ ok: true });
  }

  private async debug(url: URL): Promise<Response> {
    const sessionId = this.getSessionId(url);
    const data = this.getDataLayer();
    
    const [session, queue, eventCount, recentEvents] = await Promise.all([
      data.sessions.findById(sessionId),
      data.inputQueue.status(sessionId),
      data.events.count?.(sessionId).catch(() => 0),
      data.events.listRecent?.(sessionId, 20).catch(() => []),
    ]);

    return json({
      sessionId,
      session,
      queue,
      eventCount,
      recentEvents,
    });
  }
}

// Helper functions for session-store.ts integration

/**
 * Get the session coordinator stub for a session
 */
function getSessionCoordinator(env: Env, sessionId: string): DurableObjectStub {
  const id = env.SESSION_COORDINATOR.idFromName(sessionId);
  return env.SESSION_COORDINATOR.get(id);
}

/**
 * Queue operations through the coordinator for concurrency safety
 */

export async function coordinatorEnqueueSessionInput(
  env: Env,
  sessionId: string,
  event: SessionInputEvent
): Promise<{ ok: boolean; queued: number; error?: string }> {
  const stub = getSessionCoordinator(env, sessionId);
  const response = await stub.fetch(
    `https://session-coordinator.local/input-queue?sessionId=${encodeURIComponent(sessionId)}`,
    {
      method: "POST",
      body: JSON.stringify(event),
    }
  );

  if (!response.ok) {
    const error = await response.json() as { error: string; current?: number; max?: number };
    return {
      ok: false,
      queued: error.current ?? 0,
      error: error.error,
    };
  }

  return response.json() as Promise<{ ok: boolean; queued: number }>;
}

export async function coordinatorDequeueSessionInput(
  env: Env,
  sessionId: string
): Promise<{ event: SessionInputEvent | null; remaining: number }> {
  const stub = getSessionCoordinator(env, sessionId);
  const response = await stub.fetch(
    `https://session-coordinator.local/input-queue?sessionId=${encodeURIComponent(sessionId)}`,
    { method: "DELETE" }
  );

  if (!response.ok) {
    throw new Error(`Dequeue failed: ${response.status}`);
  }

  return response.json() as Promise<{ event: SessionInputEvent | null; remaining: number }>;
}

export async function coordinatorGetSessionInputQueue(
  env: Env,
  sessionId: string
): Promise<{ pending: number; max: number; events: SessionInputEvent[] }> {
  const stub = getSessionCoordinator(env, sessionId);
  const response = await stub.fetch(
    `https://session-coordinator.local/input-queue?sessionId=${encodeURIComponent(sessionId)}`
  );

  if (!response.ok) {
    throw new Error(`Queue status failed: ${response.status}`);
  }

  return response.json() as Promise<{ pending: number; max: number; events: SessionInputEvent[] }>;
}

/**
 * Event operations through the coordinator for sequence safety
 */

export async function coordinatorAppendSessionEvents(
  env: Env,
  sessionId: string,
  events: NewSessionEvent[]
): Promise<{ nextCursor: string }> {
  const stub = getSessionCoordinator(env, sessionId);
  const response = await stub.fetch(
    `https://session-coordinator.local/events?sessionId=${encodeURIComponent(sessionId)}`,
    {
      method: "POST",
      body: JSON.stringify({ events }),
    }
  );

  if (!response.ok) {
    throw new Error(`Append events failed: ${response.status}`);
  }

  const result = await response.json() as { ok: boolean; nextCursor: string };
  return { nextCursor: result.nextCursor };
}

export async function coordinatorGetSessionEvents(
  env: Env,
  sessionId: string,
  sinceCursor?: string,
  limit?: number
): Promise<{ events: import("./types.js").SessionEvent[]; nextCursor: string }> {
  const stub = getSessionCoordinator(env, sessionId);
  const url = new URL(`https://session-coordinator.local/events?sessionId=${encodeURIComponent(sessionId)}`);
  if (sinceCursor) url.searchParams.set("since", sinceCursor);
  if (limit) url.searchParams.set("limit", String(limit));

  const response = await stub.fetch(url.toString());

  if (!response.ok) {
    throw new Error(`Get events failed: ${response.status}`);
  }

  return response.json() as Promise<{ events: import("./types.js").SessionEvent[]; nextCursor: string }>;
}

export async function coordinatorGetLatestEventCursor(
  env: Env,
  sessionId: string
): Promise<string> {
  const stub = getSessionCoordinator(env, sessionId);
  const response = await stub.fetch(
    `https://session-coordinator.local/cursor?sessionId=${encodeURIComponent(sessionId)}`
  );

  if (!response.ok) {
    throw new Error(`Get cursor failed: ${response.status}`);
  }

  const result = await response.json() as { cursor: string };
  return result.cursor;
}

export async function coordinatorWakeWorkflow(
  env: Env,
  workflowId: string
): Promise<void> {
  const stub = getSessionCoordinator(env, "any"); // Coordinator ID doesn't matter for wake
  const response = await stub.fetch(
    `https://session-coordinator.local/wake`,
    {
      method: "POST",
      body: JSON.stringify({ workflowId }),
    }
  );

  if (!response.ok) {
    throw new Error(`Wake workflow failed: ${response.status}`);
  }
}

export async function coordinatorGetQueueStatus(
  env: Env,
  sessionId: string
): Promise<{ pending: number; max: number; events: SessionInputEvent[] }> {
  return coordinatorGetSessionInputQueue(env, sessionId);
}
