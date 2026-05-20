// Clawflare Harness - Main Worker Entry Point
// This runs in Cloudflare Workers and provides an agent powered by pi-agent-core

import { ClawflareDatastore } from "./datastore.js";
import { HttpGateway } from "./egress/gateway.js";
import { ClawflareSessionStore } from "./session-do.js";
import { PersistentSessionWorkflow } from "./persistent-workflow.js";
import { ClawflareWebSocketSession } from "./ws-session.js";
import { createTools } from "./tools/index.js";
import { normalizeBedrockBearerToken } from "./agent-config.js";
import { logTiming, timingStart } from "./diagnostics.js";
import {
  getLatestEventCursor,
  loadSessionState,
  saveSessionState,
  getSessionEvents,
  enqueueSessionInput,
  markSessionClosed,
} from "./session-store.js";
import type { Env, SessionMetadataState, SessionInputEvent } from "./internal-types/index.js";
import type {
  AgentSession,
  ChatSubmittedResponse,
  ChatRequest,
  SessionResponse,
  SessionSummary,
  SessionListResponse,
} from "./types.js";

// Export types for clients (public types only)
export type {
  AgentMessage,
  AgentSession,
  ChatSubmittedResponse,
  ChatRequest,
  SessionResponse,
  SessionSummary,
  SessionListResponse,
  SessionEvent,
} from "./types.js";

// Export the Datastore Durable Object class and Workflow
export { ClawflareDatastore, HttpGateway, ClawflareSessionStore, PersistentSessionWorkflow, ClawflareWebSocketSession };

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
      return handleGetContext();
    }

    if (path === "/v1/context" && request.method === "POST") {
      return handleNewContext(request);
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

      // Mark session as processing BEFORE returning - guarantees the session
      // cannot appear idle on immediate subsequent polls.
      existingSession.status = "processing";
      existingSession.updatedAt = Date.now();
      await saveSessionState(env, existingSession);
      logTiming(env, sessionId, "chat.session.processing_marked", requestStart);

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

      // Get fresh event cursor - not the potentially stale one from session state
      const freshEventCursor = await getLatestEventCursor(env, sessionId);
      logTiming(env, sessionId, "chat.event_cursor.fresh", requestStart);

      const response: ChatSubmittedResponse = {
        sessionId,
        eventCursor: freshEventCursor,
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
      const initialState: SessionMetadataState = {
        id: sessionId,
        workflowId,
        status: "processing",
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

    // Check if session has been processing for too long (auto-recovery for stuck workflows)
    const PROCESSING_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
    if (sessionState.status === "processing" &&
        Date.now() - sessionState.updatedAt > PROCESSING_TIMEOUT_MS) {
      console.warn(`[handleGetSession] Session ${sessionId} stuck in processing for ${Date.now() - sessionState.updatedAt}ms, marking as error`);
      sessionState.status = "error";
      sessionState.errorMessage = "Session timed out - processing took too long. Try closing this session and starting a new one.";
      sessionState.updatedAt = Date.now();
      await saveSessionState(env, sessionState);
    }

    const eventsStart = timingStart();
    const { events, nextCursor } = await getSessionEvents(
      env,
      sessionId,
      sinceCursor || undefined,
      100
    );

    logTiming(env, sessionId, "session.poll", pollStart, {
      status: sessionState.status,
      messageCount: 0,
      eventCount: events.length,
      sinceCursor,
      loadStateMs: eventsStart - loadStateStart,
      getEventsMs: Date.now() - eventsStart,
    });

    // Assemble public SessionResponse
    const response: SessionResponse = {
      id: sessionState.id,
      status: sessionState.status,
      messages: [],
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

    const inputEvent: SessionInputEvent = { type: "close" };
    await enqueueSessionInput(env, sessionId, inputEvent);

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
    const statusFilter = url.searchParams.get("status");

    const response: SessionListResponse = {
      sessions: [],
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
          messageCount: 0,
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
async function handleGetContext(): Promise<Response> {
  try {
    const context: AgentSession = {
      id: "main",
      messages: [],
      createdAt: Date.now(),
    };

    return new Response(JSON.stringify(context), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[handleGetContext] Error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}

// Handle new context creation - create in the strongly consistent session Durable Object.
async function handleNewContext(request: Request): Promise<Response> {
  try {
    const body = (await request.json()) as { parentId?: string; };
    const sessionId = crypto.randomUUID();

    const context: AgentSession = {
      id: sessionId,
      parentId: body.parentId,
      messages: [],
      createdAt: Date.now(),
    };

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
async function handleListTools(env: Env, _ctx: ExecutionContext): Promise<Response> {
  try {
    const tools = createTools(env, _ctx);
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
    const contextWindow = 128000;
    const rawBedrockToken = env.AWS_BEARER_TOKEN_BEDROCK || "";
    const normalizedBedrockToken = normalizeBedrockBearerToken(rawBedrockToken) || "";

    return new Response(JSON.stringify({
      provider,
      model,
      contextWindow,
      mockAi: env.MOCK_AI,
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

async function sha256Prefix(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash))
    .slice(0, 8)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
