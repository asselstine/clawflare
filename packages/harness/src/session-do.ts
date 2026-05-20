import { DurableObject } from "cloudflare:workers";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { AgentSessionState } from "./agent";
import type { AgentSession, Env, SessionEvent, SessionState } from "./types";

const MAX_EVENTS_PER_SESSION = 1000;
const EVENT_TRIM_BATCH = 100;

const STATE_KEY = "state";
const EVENT_META_KEY = "event_meta";
const EVENT_PREFIX = "evt/";
const WORKFLOW_SESSION_KEY = "workflowSession";
const CONTEXT_KEY = "context";

const MAX_STORAGE_SIZE = 130000;

type NewSessionEvent = AgentEvent & { timestamp: number };

interface EventMeta {
  nextSequence: number;
  oldestSequence: number;
  count: number;
}

interface StorageErrorDetails {
  requestedSize: number;
  limit: number;
  key: string;
  messageSize: number;
  messageCount: number;
  suggestedAction: string;
}

class StorageQuotaError extends Error {
  public readonly details: StorageErrorDetails;
  
  constructor(details: StorageErrorDetails) {
    super(`Storage quota exceeded: ${details.requestedSize} bytes exceeds ${details.limit} byte limit`);
    this.name = "StorageQuotaError";
    this.details = details;
  }
}

function checkStorageSize(value: unknown, key: string): void {
  const serialized = JSON.stringify(value);
  const size = new TextEncoder().encode(serialized).length;
  
  const messages = (value as { messages?: unknown[] })?.messages;
  const messageCount = messages?.length ?? 0;
  const messageSize = messages ? JSON.stringify(messages).length : 0;
  
  if (size > MAX_STORAGE_SIZE) {
    throw new StorageQuotaError({
      requestedSize: size,
      limit: MAX_STORAGE_SIZE,
      key,
      messageSize,
      messageCount,
      suggestedAction: "Session has grown too large. Start a new session with /new or clear history with /clear",
    });
  }
}

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
      if (path === "/context" && request.method === "GET") return this.getContext();
      if (path === "/context" && request.method === "PUT") return this.putContext(request);
      if (path === "/cf_debug" && request.method === "GET") return this.getDebugInfo(url);

      return json({ error: "Not found" }, 404);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  }

  private async getState(): Promise<Response> {
    const state = await this.ctx.storage.get<SessionState>(STATE_KEY);
    return state ? json(state) : json({ error: "Session state not found" }, 404);
  }

  private async putState(request: Request): Promise<Response> {
    const state = await request.json<SessionState>();
    
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
    const state = await this.ctx.storage.get<SessionState>(STATE_KEY);
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
    const body = await request.json<{ events: NewSessionEvent[] }>();
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
    const session = await this.ctx.storage.get<AgentSessionState>(WORKFLOW_SESSION_KEY);
    return session ? json(session) : json({ error: "Workflow session not found" }, 404);
  }

  private async putWorkflowSession(request: Request): Promise<Response> {
    const session = await request.json<AgentSessionState>();
    
    try {
      checkStorageSize(session, WORKFLOW_SESSION_KEY);
      await this.ctx.storage.put(WORKFLOW_SESSION_KEY, session);

      const context: AgentSession = {
        id: session.id,
        messages: session.messages,
        createdAt: session.createdAt,
      };
      await this.ctx.storage.put(CONTEXT_KEY, context);

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

  private async getContext(): Promise<Response> {
    const context = await this.ctx.storage.get<AgentSession>(CONTEXT_KEY);
    if (context) return json(context);

    const workflowSession = await this.ctx.storage.get<AgentSessionState>(WORKFLOW_SESSION_KEY);
    if (workflowSession) {
      return json({
        id: workflowSession.id,
        messages: workflowSession.messages,
        createdAt: workflowSession.createdAt,
      } satisfies AgentSession);
    }

    return json({ error: "Context not found" }, 404);
  }

  private async putContext(request: Request): Promise<Response> {
    const context = await request.json<AgentSession>();
    await this.ctx.storage.put(CONTEXT_KEY, context);
    return json({ ok: true });
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
    const allKeys = [STATE_KEY, EVENT_META_KEY, WORKFLOW_SESSION_KEY, CONTEXT_KEY, 
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

    // Message breakdown
    let messageBreakdown = null;
    try {
      const session = await this.ctx.storage.get<AgentSessionState>(WORKFLOW_SESSION_KEY);
      if (session?.messages) {
        const messages = session.messages;
        messageBreakdown = {
          count: messages.length,
          roles: messages.reduce((acc: Record<string, number>, m) => {
            const role = (m as { role?: string }).role || "unknown";
            acc[role] = (acc[role] || 0) + 1;
            return acc;
          }, {} as Record<string, number>),
          sizes: messages.slice(-10).map((m, i) => {
            const serialized = JSON.stringify(m);
            return {
              index: messages.length - 10 + i,
              role: (m as { role?: string }).role || "unknown",
              sizeBytes: new TextEncoder().encode(serialized).length,
              sizeHuman: formatBytes(new TextEncoder().encode(serialized).length),
              preview: serialized.slice(0, 200),
            };
          }),
        };
      }
    } catch {
      // ignore
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
      messageBreakdown,
    });
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}