// Clawflare Harness - Main Worker Entry Point
// This runs in Cloudflare Workers and provides an agent powered by pi-agent-core

import { ClawflareDatastore } from "./datastore";
import { HttpGateway } from "./egress/gateway";
import { ClawflareSessionStore } from "./session-do";
import { PersistentSessionWorkflow } from "./persistent-workflow";
import { ClawflareWebSocketSession } from "./ws-session";
import { createTools } from "./tools";
import { normalizeBedrockBearerToken } from "./agent-config";
import { logTiming, timingStart } from "./diagnostics";
import {
  getLatestEventCursor,
  loadSessionState,
  saveSessionState,
  getSessionEvents,
  enqueueSessionInput,
  markSessionClosed,
} from "./session-store";
import type { Env, AgentSession, ChatSubmittedResponse, SessionResponse, SessionState } from "./types";
import type { ChatRequest, SessionListResponse, SessionSummary } from "./public-types";

// Export the Datastore Durable Object class and Workflow
export { ClawflareDatastore, HttpGateway, ClawflareSessionStore, PersistentSessionWorkflow, ClawflareWebSocketSession };

// Export types for clients (from public-types.ts to avoid Workers types)
export type { 
  AgentMessage,
  SessionEvent,
  SessionState,
  SessionResponse,
  ChatSubmittedResponse,
  ChatRequest,
  AgentSession,
  SessionListResponse,
  SessionSummary,
} from "./public-types";

// Parse authorization header
function getToken(request: Request): string | null {
  const auth = request.headers.get("Authorization");
  if (!auth || !auth.startsWith("Bearer ")) {
    return null;
  }
  return auth.slice(7);
}

// Simple bearer token authentication
function authenticate(request: Request, env: Env): Response | null {
  const token = getToken(request);
  if (!token || token !== env.CLAWFLARE_API_TOKEN) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  return null;
}

// Handle HTTP requests
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, ""); // Normalize trailing slash
    const isSessionPoll = request.method === "GET" && path.startsWith("/v1/session/");

    if (!isSessionPoll) {
      console.log(`[REQUEST] ${request.method} ${request.url}`);
    }
    
    // Validate API_TOKEN is configured
    if (!env.CLAWFLARE_API_TOKEN || env.CLAWFLARE_API_TOKEN.trim() === "") {
      console.error("[ERROR] CLAWFLARE_API_TOKEN not configured");
      return new Response(
        JSON.stringify({ error: "CLAWFLARE_API_TOKEN not configured. Set via: wrangler secret put CLAWFLARE_API_TOKEN or create a .dev.vars file" }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    // Health check (no auth required for simplicity in dev)
    if (path === "/health") {
      return new Response(JSON.stringify({ status: "ok" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Authenticate all other requests
    const authError = authenticate(request, env);
    if (authError) return authError;

    // WebSocket upgrade for interactive workflow sessions
    if (path === "/ws") {
      const id = env.WEBSOCKET_SESSION.idFromName(crypto.randomUUID());
      return env.WEBSOCKET_SESSION.get(id).fetch(request);
    }

    // Session-based chat endpoint - returns immediately with session handle
    if (path === "/v1/chat" && request.method === "POST") {
      return handleSessionChat(request, env);
    }

    // Session polling endpoint
    if (path.startsWith("/v1/session/") && request.method === "GET") {
      const sessionId = path.replace("/v1/session/", "");
      return handleGetSession(sessionId, url, env);
    }

    // Session close endpoint - close an active session
    if (path.startsWith("/v1/session/") && path.endsWith("/close") && request.method === "POST") {
      const sessionId = path.replace("/v1/session/", "").replace("/close", "");
      return handleCloseSession(sessionId, env);
    }

    // Sessions list endpoint - list all sessions
    if (path === "/v1/sessions" && request.method === "GET") {
      return handleListSessions(url, env);
    }

    // Context endpoints
    if (path === "/v1/context" && request.method === "GET") {
      return handleGetContext(env);
    }

    if (path === "/v1/context" && request.method === "POST") {
      return handleNewContext(request, env);
    }

    if (path === "/v1/tools" && request.method === "GET") {
      return handleListTools(env, ctx);
    }

    // Server info endpoint
    if (path === "/v1/info" && request.method === "GET") {
      return handleGetInfo(env);
    }

    // Debug endpoint - inspect DO storage details
    if (path === "/v1/cf_debug" && request.method === "GET") {
      return handleCfDebug(env, url);
    }

    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  },
};

// Handle session-based chat - returns session handle immediately
// Uses persistent workflow: one workflow per session, stays alive until closed
async function handleSessionChat(request: Request, env: Env): Promise<Response> {
  const requestStart = timingStart();
  let sessionId: string | undefined;

  try {
    const body = (await request.json()) as ChatRequest;
    
    if (body.type !== "prompt" || !body.content) {
      return new Response(
        JSON.stringify({ error: "Invalid request. type='prompt' and content required" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    sessionId = body.sessionId || crypto.randomUUID();
    logTiming(env, sessionId, "chat.request.parsed", requestStart, {
      hasExistingSession: Boolean(body.sessionId),
      promptLength: body.content.length,
      action: body.sessionId ? "sendEvent" : "createWorkflow",
    });

    const existingSession = body.sessionId ? await loadSessionState(env, body.sessionId) : null;

    if (existingSession) {
      // EXISTING SESSION: Send event to running workflow
      logTiming(env, sessionId, "chat.sendEvent.start", requestStart);

      if (existingSession.status === "closed" || existingSession.status === "expired") {
        return new Response(
          JSON.stringify({ error: "Session closed. Create a new session to continue." }),
          { status: 410, headers: { "Content-Type": "application/json" } }
        );
      }

      // Get workflow ID
      const workflowId = existingSession.workflowId;
      if (!workflowId) {
        return new Response(
          JSON.stringify({ error: "Session has no associated workflow" }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }

      // Queue the event first (for ordering guarantees)
      const enqueueResult = await enqueueSessionInput(env, sessionId, {
        type: "prompt",
        content: body.content,
        maxTurns: body.maxTurns,
      });

      if (!enqueueResult.ok) {
        return new Response(
          JSON.stringify({ error: enqueueResult.error, queued: enqueueResult.queued }),
          { status: 429, headers: { "Content-Type": "application/json" } }
        );
      }

      // Send a wake event to trigger the workflow to consume the durable queue.
      const eventStart = timingStart();
      const workflowInstance = await env.AGENT_WORKFLOW.get(workflowId);
      await workflowInstance.sendEvent({
        type: "session-input",
        payload: { type: "wake" },
      });
      logTiming(env, sessionId, "chat.sendEvent.done", eventStart);

      const response: ChatSubmittedResponse = {
        sessionId,
        eventCursor: existingSession.nextEventCursor,
        isNewSession: false,
      };

      logTiming(env, sessionId, "chat.response.returning", requestStart);
      return new Response(JSON.stringify(response), {
        headers: { "Content-Type": "application/json" },
      });
    } else {
      // NEW SESSION: Create persistent workflow
      logTiming(env, sessionId, "chat.workflow.create.start", requestStart);

      const initialEventCursor = await getLatestEventCursor(env, sessionId);
      const workflowId = crypto.randomUUID();

      // Initialize session state
      const initialState: SessionState = {
        id: sessionId,
        workflowId,
        status: "processing",  // Start as processing, workflow will set to idle when done
        messages: [],
        nextEventCursor: initialEventCursor,
        updatedAt: Date.now(),
        maxQueueSize: 100,
        idleTimeout: "7 days",
      };
      await saveSessionState(env, initialState);
      logTiming(env, sessionId, "chat.session_state.saved", requestStart);

      // Create persistent workflow
      await env.AGENT_WORKFLOW.create({
        id: workflowId,
        params: { sessionId },
      });
      logTiming(env, sessionId, "chat.workflow.create.done", requestStart);

      // Queue the event before waking the workflow so the workflow has a
      // durable source of truth even if the wake event arrives while it is not
      // yet waiting for input.
      await enqueueSessionInput(env, sessionId, {
        type: "prompt",
        content: body.content,
        maxTurns: body.maxTurns,
      });

      // Get workflow instance and wake it to consume the queued prompt.
      const workflowInstance = await env.AGENT_WORKFLOW.get(workflowId);
      await workflowInstance.sendEvent({
        type: "session-input",
        payload: { type: "wake" },
      });

      const response: ChatSubmittedResponse = {
        sessionId,
        eventCursor: initialState.nextEventCursor,
        isNewSession: true,
      };

      logTiming(env, sessionId, "chat.response.returning", requestStart);
      return new Response(JSON.stringify(response), {
        headers: { "Content-Type": "application/json" },
      });
    }
  } catch (error) {
    logTiming(env, sessionId, "chat.request.error", requestStart, {
      error: error instanceof Error ? error.message : String(error),
    });
    console.error("[handleSessionChat] Error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}

// Get session state - polls for messages and events
async function handleGetSession(
  sessionId: string,
  url: URL,
  env: Env,
): Promise<Response> {
  const pollStart = timingStart();

  try {
    // Load session state
    const loadStateStart = timingStart();
    const sessionState = await loadSessionState(env, sessionId);
    if (!sessionState) {
      logTiming(env, sessionId, "session.poll.not_found", pollStart);
      return new Response(
        JSON.stringify({ error: "Session not found" }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }

    // Get events since cursor
    const sinceCursor = url.searchParams.get("since");
    const eventsStart = timingStart();
    const { events, nextCursor } = await getSessionEvents(
      env,
      sessionId,
      sinceCursor || undefined,
      100
    );

    logTiming(env, sessionId, "session.poll", pollStart, {
      status: sessionState.status,
      messageCount: sessionState.messages.length,
      eventCount: events.length,
      sinceCursor,
      loadStateMs: eventsStart - loadStateStart,
      getEventsMs: Date.now() - eventsStart,
    });

    const response: SessionResponse = {
      id: sessionState.id,
      status: sessionState.status,
      messages: sessionState.messages,
      events,
      nextEventCursor: nextCursor,
      errorMessage: sessionState.errorMessage,
    };

    return new Response(JSON.stringify(response), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    logTiming(env, sessionId, "session.poll.error", pollStart, {
      error: error instanceof Error ? error.message : String(error),
    });
    console.error("[handleGetSession] Error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}

// Close a session - sends close event to workflow
async function handleCloseSession(sessionId: string, env: Env): Promise<Response> {
  try {
    const session = await loadSessionState(env, sessionId);
    if (!session) {
      return new Response(
        JSON.stringify({ error: "Session not found" }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }

    if (session.status === "closed" || session.status === "expired") {
      return new Response(
        JSON.stringify({ error: "Session already closed" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    if (!session.workflowId) {
      return new Response(
        JSON.stringify({ error: "Session has no associated workflow" }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    await enqueueSessionInput(env, sessionId, { type: "close" });

    // Get workflow instance and wake it to consume the queued close event.
    const workflowInstance = await env.AGENT_WORKFLOW.get(session.workflowId);
    await workflowInstance.sendEvent({
      type: "session-input",
      payload: { type: "wake" },
    });

    // Mark session as closed immediately (workflow will also set this, but we set it here for immediate UI feedback)
    await markSessionClosed(env, sessionId, "user");

    return new Response(JSON.stringify({ ok: true, sessionId, status: "closed" }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[handleCloseSession] Error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}

// List sessions - returns active and recent sessions
async function handleListSessions(url: URL, env: Env): Promise<Response> {
  try {
    // Read optional status filter
    const statusFilter = url.searchParams.get("status"); // "active", "idle", "closed", "expired", "error", or null for all
    
    // NOTE: Listing all sessions requires scanning DOs which is expensive.
    // In production, you'd want to maintain an index (e.g., in KV or separate DO).
    // For now, this is a scaffold that returns a note about implementation.
    
    // Placeholder: In a production implementation, you'd:
    // 1. Have a SessionsIndex DO that tracks all sessions
    // 2. Query that by status
    // 3. Return paginated results
    
    const response: SessionListResponse = {
      sessions: [], // Would be populated from sessions index
      total: 0,
    };
    
    // If specific session ID provided, return that one
    const sessionId = url.searchParams.get("sessionId");
    if (sessionId) {
      const state = await loadSessionState(env, sessionId);
      if (state) {
        const summary: SessionSummary = {
          id: state.id,
          workflowId: state.workflowId,
          status: state.status,
          messageCount: state.messages.length,
          updatedAt: state.updatedAt,
          isActive: state.status === "idle" || state.status === "processing",
        };
        if (!statusFilter || statusFilter === "all" || state.status === statusFilter) {
          response.sessions.push(summary);
          response.total = 1;
        }
      }
    }

    return new Response(JSON.stringify(response), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[handleListSessions] Error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}

// Handle get context - read from the strongly consistent session Durable Object.
async function handleGetContext(env: Env): Promise<Response> {
  try {
    const context = await loadContext(env, "main") || {
      id: "main",
      messages: [],
      createdAt: Date.now(),
    } satisfies AgentSession;
    
    return new Response(JSON.stringify(context), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[handleGetContext] Error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error", stack: error instanceof Error ? error.stack : undefined }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}

// Handle new context creation - create in the strongly consistent session Durable Object.
async function handleNewContext(request: Request, env: Env): Promise<Response> {
  try {
    const body = (await request.json()) as { parentId?: string; };
    const sessionId = crypto.randomUUID();
    const parent = body.parentId ? await loadContext(env, body.parentId) : null;
    
    const context: AgentSession = {
      id: sessionId,
      parentId: body.parentId,
      messages: parent?.messages ? [...parent.messages] : [],
      createdAt: Date.now(),
    };

    await saveContext(env, context);
    
    return new Response(JSON.stringify(context), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}

// Handle list tools - create tools directly
async function handleListTools(env: Env, ctx: ExecutionContext): Promise<Response> {
  try {
    const tools = createTools(env, ctx);
    return new Response(JSON.stringify({ tools }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}

// Handle get server info (provider, model, context window)
async function handleGetInfo(env: Env): Promise<Response> {
  try {
    const provider = env.AI_PROVIDER || "amazon-bedrock";
    const model = env.AI_MODEL || "minimax.minimax-m2.5";
    const contextWindow = 128000; // Default context window for minimax-m2.5
    const rawBedrockToken = env.AWS_BEARER_TOKEN_BEDROCK || "";
    const normalizedBedrockToken = normalizeBedrockBearerToken(rawBedrockToken) || "";
    
    return new Response(JSON.stringify({ 
      provider, 
      model, 
      contextWindow,
      bedrockAuth: {
        configured: normalizedBedrockToken.length > 0,
        rawLength: rawBedrockToken.length,
        normalizedLength: normalizedBedrockToken.length,
        hadBearerPrefix: /\s*Bearer\s+/i.test(rawBedrockToken),
        fingerprint: normalizedBedrockToken ? await sha256Prefix(normalizedBedrockToken) : undefined,
      },
    }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}

// Handle cf_debug - inspect DO storage details
async function handleCfDebug(env: Env, url: URL): Promise<Response> {
  try {
    const sessionId = url.searchParams.get("sessionId");
    const key = url.searchParams.get("key");
    
    if (!sessionId) {
      return new Response(
        JSON.stringify({ error: "sessionId query param required" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const response = await getSessionStore(env, sessionId).fetch(
      `https://session-store.local/cf_debug${key ? `?key=${key}` : ""}`
    );
    
    if (!response.ok) {
      const errorText = await response.text();
      return new Response(
        JSON.stringify({ error: `Debug fetch failed: ${response.status} - ${errorText}` }),
        { status: response.status, headers: { "Content-Type": "application/json" } }
      );
    }
    
    const data = await response.json();
    return new Response(JSON.stringify(data, null, 2), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}

function getSessionStore(env: Env, sessionId: string): DurableObjectStub {
  const id = env.SESSION_STORE.idFromName(sessionId);
  return env.SESSION_STORE.get(id);
}

async function loadContext(env: Env, sessionId: string): Promise<AgentSession | null> {
  const response = await getSessionStore(env, sessionId).fetch("https://session-store.local/context");
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Context fetch failed: ${response.status} ${await response.text()}`);
  }
  return response.json() as Promise<AgentSession>;
}

async function saveContext(env: Env, context: AgentSession): Promise<void> {
  const response = await getSessionStore(env, context.id).fetch("https://session-store.local/context", {
    method: "PUT",
    body: JSON.stringify(context),
  });
  if (!response.ok) {
    throw new Error(`Context save failed: ${response.status} ${await response.text()}`);
  }
}

async function sha256Prefix(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash))
    .slice(0, 8)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
