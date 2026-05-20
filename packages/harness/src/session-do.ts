import { DurableObject } from "cloudflare:workers";
import type {
  Env,
  SessionMetadataState,
  SessionInputEvent,
  SessionEvent,
  EventMeta,
  AgentSessionSnapshot,
} from "./internal-types/index.js";
import {
  StorageQuotaError,
  checkStorageSize,
} from "./internal-types/session.js";

// Storage keys
const STATE_KEY = "state";
const EVENT_META_KEY = "event_meta";
const EVENT_PREFIX = "evt/";
const WORKFLOW_SESSION_KEY = "workflowSession";
const WORKFLOW_ID_KEY = "workflowId";
const INPUT_QUEUE_KEY = "inputQueue";
const SESSION_ACTIVE_KEY = "sessionActive";
const SNAPSHOT_KEY = "snapshot";

const MAX_EVENTS_PER_SESSION = 1000;
const EVENT_TRIM_BATCH = 100;

function eventKey(sequence: number): string {
  return `${EVENT_PREFIX}${sequence}`;
}

export class ClawflareSessionStore extends DurableObject<Env> {
  constructor(ctx: DurableObjectState<Env>, env: Env) {
    super(ctx, env);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, "");

    try {
      if (path === "/state" && request.method === "GET") return this.getState();
      if (path === "/state" && request.method === "PUT") return this.putState(request);
      if (path === "/state/error" && request.method === "POST") return this.markError(request);
      if (path === "/events" && request.method === "GET") return this.getEvents(url);
      if (path === "/events" && request.method === "POST") return this.appendEvents(request);
      if (path === "/cursor" && request.method === "GET") return this.getCursor();
      if (path === "/workflow-session" && request.method === "GET") return this.getWorkflowSession();
      if (path === "/workflow-session" && request.method === "PUT") return this.putWorkflowSession(request);
      if (path === "/snapshot" && request.method === "GET") return this.getSnapshot();
      if (path === "/snapshot" && request.method === "PUT") return this.putSnapshot(request);

      // Persistent workflow endpoints
      if (path === "/workflow-id" && request.method === "GET") return this.getWorkflowId();
      if (path === "/workflow-id" && request.method === "PUT") return this.putWorkflowId(request);
      if (path === "/input-queue" && request.method === "GET") return this.getInputQueue();
      if (path === "/input-queue" && request.method === "POST") return this.enqueueInput(request);
      if (path === "/input-queue" && request.method === "DELETE") return this.dequeueInput();
      if (path === "/session-active" && request.method === "GET") return this.getSessionActive();
      if (path === "/session-active" && request.method === "PUT") return this.putSessionActive(request);

      if (path === "/cf_debug" && request.method === "GET") return this.getDebugInfo(url);

      return json({ error: "Not found" }, 404);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  }

  private async getState(): Promise<Response> {
    const state = await this.ctx.storage.get<SessionMetadataState>(STATE_KEY);
    return state ? json(state) : json({ error: "Session state not found" }, 404);
  }

  private async putState(request: Request): Promise<Response> {
    const state = await request.json<SessionMetadataState>();

    try {
      checkStorageSize(state, STATE_KEY);
      await this.ctx.storage.put(STATE_KEY, state);
      return json({ ok: true });
    } catch (error) {
      if (error instanceof StorageQuotaError) {
        return json({
          error: "Session too large",
          details: error.details,
          hint: error.details.suggestedAction,
        }, 413);
      }
      throw error;
    }
  }

  private async markError(request: Request): Promise<Response> {
    const body = await request.json<{ message: string }>();
    const state = await this.ctx.storage.get<SessionMetadataState>(STATE_KEY);
    if (!state) return json({ ok: false, missing: true });

    state.status = "error";
    state.errorMessage = body.message;
    state.updatedAt = Date.now();
    await this.ctx.storage.put(STATE_KEY, state);
    return json({ ok: true });
  }

  // Get events from decomposed storage - fetch individual keys
  private async getEvents(url: URL): Promise<Response> {
    const meta = await this.getEventMeta();
    const sinceSequence = parseInt(url.searchParams.get("since") || "0", 10);
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "100", 10), 100);

    const startSeq = Math.max(sinceSequence + 1, meta.oldestSequence);
    const endSeq = Math.min(startSeq + limit - 1, meta.nextSequence - 1);

    if (startSeq > endSeq) {
      return json({ events: [], nextCursor: String(sinceSequence) });
    }

    // Build keys to fetch
    const keysToFetch: string[] = [];
    for (let seq = startSeq; seq <= endSeq; seq++) {
      keysToFetch.push(eventKey(seq));
    }

    // Fetch - returns Map<string, SessionEvent>
    const events: SessionEvent[] = [];
    if (keysToFetch.length > 0) {
      const fetched = await this.ctx.storage.get<SessionEvent>(keysToFetch);
      if (fetched instanceof Map) {
        for (const [, value] of fetched) {
          if (value) events.push(value);
        }
      }
    }

    // Sort by sequence
    events.sort((a, b) => a.sequence - b.sequence);

    const nextCursor = events.length > 0
      ? String(events[events.length - 1]!.sequence)
      : String(sinceSequence);

    return json({ events, nextCursor });
  }

  // Append events as individual keys - no more 128KB limit
  private async appendEvents(request: Request): Promise<Response> {
    const body = await request.json<{ events: SessionEvent[] }>();
    const newEvents = body.events || [];
    if (newEvents.length === 0) return json({ ok: true });

    const meta = await this.getEventMeta();

    // Build events with sequences and store each individually
    const eventsToStore: SessionEvent[] = [];
    const putPromises: Promise<void>[] = [];

    for (let i = 0; i < newEvents.length; i++) {
      const event: SessionEvent = {
        ...newEvents[i]!,
        sequence: meta.nextSequence + i,
      };
      eventsToStore.push(event);
      putPromises.push(this.ctx.storage.put(eventKey(event.sequence), event));
    }

    // Store all events in parallel (each is small)
    await Promise.all(putPromises);

    // Update meta
    const newNextSequence = meta.nextSequence + newEvents.length;
    let newOldestSequence = meta.oldestSequence;

    // Check if we need to trim old events
    const estimatedCount = newNextSequence - meta.oldestSequence;
    if (estimatedCount > MAX_EVENTS_PER_SESSION) {
      const targetOldest = newNextSequence - MAX_EVENTS_PER_SESSION;
      const deleteUpTo = Math.min(targetOldest, meta.oldestSequence + EVENT_TRIM_BATCH);
      const keysToDelete: string[] = [];
      for (let seq = meta.oldestSequence; seq < deleteUpTo; seq++) {
        keysToDelete.push(eventKey(seq));
      }
      if (keysToDelete.length > 0) {
        await this.ctx.storage.delete(keysToDelete);
        newOldestSequence = deleteUpTo;
      }
    }

    await this.ctx.storage.put(EVENT_META_KEY, {
      nextSequence: newNextSequence,
      oldestSequence: newOldestSequence,
      count: newNextSequence - newOldestSequence,
    } satisfies EventMeta);

    return json({
      ok: true,
      nextCursor: String(eventsToStore[eventsToStore.length - 1]?.sequence ?? meta.nextSequence - 1)
    });
  }

  private async getEventMeta(): Promise<EventMeta> {
    return await this.ctx.storage.get<EventMeta>(EVENT_META_KEY) ?? {
      nextSequence: 1,
      oldestSequence: 1,
      count: 0,
    };
  }

  private async getCursor(): Promise<Response> {
    const meta = await this.getEventMeta();
    return json({ cursor: String(Math.max(0, meta.nextSequence - 1)) });
  }

  private async getWorkflowSession(): Promise<Response> {
    const session = await this.ctx.storage.get<AgentSessionSnapshot>(WORKFLOW_SESSION_KEY);
    return session ? json(session) : json({ error: "Workflow session not found" }, 404);
  }

  private async putWorkflowSession(request: Request): Promise<Response> {
    const session = await request.json<AgentSessionSnapshot>();

    try {
      checkStorageSize(session, WORKFLOW_SESSION_KEY);
      await this.ctx.storage.put(WORKFLOW_SESSION_KEY, session);
      return json({ ok: true });
    } catch (error) {
      if (error instanceof StorageQuotaError) {
        return json({
          error: "Session too large",
          details: error.details,
          hint: error.details.suggestedAction,
        }, 413);
      }
      throw error;
    }
  }

  private async getSnapshot(): Promise<Response> {
    const snapshot = await this.ctx.storage.get<AgentSessionSnapshot>(SNAPSHOT_KEY);
    return snapshot ? json(snapshot) : json({ error: "Snapshot not found" }, 404);
  }

  private async putSnapshot(request: Request): Promise<Response> {
    const snapshot = await request.json<AgentSessionSnapshot>();

    try {
      checkStorageSize(snapshot, SNAPSHOT_KEY);
      await this.ctx.storage.put(SNAPSHOT_KEY, snapshot);
      return json({ ok: true });
    } catch (error) {
      if (error instanceof StorageQuotaError) {
        return json({
          error: "Session too large",
          details: error.details,
          hint: error.details.suggestedAction,
        }, 413);
      }
      throw error;
    }
  }

  // Persistent Workflow Session Methods

  /** Get the persistent workflow ID for this session */
  private async getWorkflowId(): Promise<Response> {
    const workflowId = await this.ctx.storage.get<string>(WORKFLOW_ID_KEY);
    return workflowId ? json({ workflowId }) : json({ error: "Workflow ID not set" }, 404);
  }

  /** Store the persistent workflow ID for this session */
  private async putWorkflowId(request: Request): Promise<Response> {
    const body = await request.json<{ workflowId: string }>();
    if (!body.workflowId) {
      return json({ error: "workflowId required" }, 400);
    }
    await this.ctx.storage.put(WORKFLOW_ID_KEY, body.workflowId);
    return json({ ok: true });
  }

  /** Get the input event queue status */
  private async getInputQueue(): Promise<Response> {
    const queue = await this.ctx.storage.get<SessionInputEvent[]>(INPUT_QUEUE_KEY) ?? [];
    return json({ pending: queue.length, max: 100, events: queue });
  }

  /** Add an input event to the queue - called by HTTP handler before sendEvent */
  private async enqueueInput(request: Request): Promise<Response> {
    const event = await request.json<SessionInputEvent>();
    const queue = await this.ctx.storage.get<SessionInputEvent[]>(INPUT_QUEUE_KEY) ?? [];

    if (queue.length >= 100) {
      return json({ error: "Queue full", current: queue.length, max: 100 }, 429);
    }

    queue.push(event);
    await this.ctx.storage.put(INPUT_QUEUE_KEY, queue);

    return json({ ok: true, queued: queue.length });
  }

  /** Remove and return next input event - called by workflow via waitForEvent */
  private async dequeueInput(): Promise<Response> {
    const queue = await this.ctx.storage.get<SessionInputEvent[]>(INPUT_QUEUE_KEY) ?? [];

    if (queue.length === 0) {
      return json({ event: null, remaining: 0 });
    }

    const event = queue.shift()!;
    await this.ctx.storage.put(INPUT_QUEUE_KEY, queue);

    return json({ event, remaining: queue.length });
  }

  /** Check if session is active (workflow running) */
  private async getSessionActive(): Promise<Response> {
    const active = await this.ctx.storage.get<boolean>(SESSION_ACTIVE_KEY) ?? false;
    return json({ active });
  }

  /** Mark session active/inactive - set by workflow on start/end */
  private async putSessionActive(request: Request): Promise<Response> {
    const body = await request.json<{ active: boolean }>();
    await this.ctx.storage.put(SESSION_ACTIVE_KEY, body.active ?? false);
    return json({ ok: true, active: body.active });
  }

  // Debug endpoint - shows decomposed storage stats
  private async getDebugInfo(url: URL): Promise<Response> {
    const key = url.searchParams.get("key");

    // List all storage keys
    const storedKeys: string[] = [];
    const listResult = await this.ctx.storage.list<string>();
    for (const [k] of listResult) {
      storedKeys.push(k);
    }

    // Get stats for known keys and sample event keys
    const keyStats: Array<{ key: string; exists: boolean; sizeBytes?: number; sizeHuman: string; error?: string }> = [];
    const allKeys = [STATE_KEY, EVENT_META_KEY, WORKFLOW_SESSION_KEY, SNAPSHOT_KEY,
      WORKFLOW_ID_KEY, INPUT_QUEUE_KEY, SESSION_ACTIVE_KEY,
      ...storedKeys.filter(k => k.startsWith(EVENT_PREFIX)).slice(0, 10)];

    for (const k of allKeys) {
      try {
        const value = await this.ctx.storage.get(k);
        const serialized = value ? JSON.stringify(value) : null;
        const size = serialized ? new TextEncoder().encode(serialized).length : 0;
        keyStats.push({
          key: k,
          exists: value !== null && value !== undefined,
          sizeBytes: size,
          sizeHuman: formatBytes(size),
        });
      } catch (e) {
        keyStats.push({
          key: k,
          exists: false,
          error: e instanceof Error ? e.message : String(e),
          sizeHuman: "0 B",
        });
      }
    }

    const meta = await this.getEventMeta();
    const eventKeyCount = storedKeys.filter(k => k.startsWith(EVENT_PREFIX)).length;

    // Sample event sizes
    const eventSamples: Array<{ key: string; sizeHuman: string; type?: string }> = [];
    const eventKeys = storedKeys.filter(k => k.startsWith(EVENT_PREFIX)).slice(-5);
    for (const evtKey of eventKeys) {
      try {
        const evt = await this.ctx.storage.get<SessionEvent>(evtKey);
        const size = evt ? new TextEncoder().encode(JSON.stringify(evt)).length : 0;
        eventSamples.push({
          key: evtKey,
          sizeHuman: formatBytes(size),
          type: evt?.type,
        });
      } catch {
        eventSamples.push({ key: evtKey, sizeHuman: "error" });
      }
    }

    // Optional: full value preview
    let fullValueStats: unknown = null;
    if (key) {
      try {
        const fullValue = await this.ctx.storage.get(key);
        if (fullValue) {
          const serialized = JSON.stringify(fullValue);
          fullValueStats = {
            key,
            sizeBytes: new TextEncoder().encode(serialized).length,
            sizeHuman: formatBytes(new TextEncoder().encode(serialized).length),
            preview: serialized.slice(0, 2000),
          };
        }
      } catch (e) {
        fullValueStats = {
          key,
          error: e instanceof Error ? e.message : String(e),
        };
      }
    }

    return json({
      timestamp: Date.now(),
      doId: this.ctx.id.toString(),
      storage: {
        totalKeys: storedKeys.length,
        eventKeys: eventKeyCount,
        knownKeys: keyStats.length,
      },
      keyStats,
      eventMeta: meta,
      eventSamples,
      fullValueStats,
    });
  }
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
