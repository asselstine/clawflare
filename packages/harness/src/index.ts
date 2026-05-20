// Clawflare Harness - Main Worker Entry Point
// This runs in Cloudflare Workers and provides an agent powered by pi-agent-core

import { ClawflareDatastore } from "./datastore";
import { HttpGateway } from "./egress/gateway";
import { ClawflareSessionStore } from "./session-do";
import { Workflow, startAgentWorkflow } from "./workflow";
import { ClawflareWebSocketSession } from "./ws-session";
import { createTools } from "./tools";
import { normalizeBedrockBearerToken } from "./agent-config";
import { logTiming, timingStart } from "./diagnostics";
import { getLatestEventCursor, loadSessionState, saveSessionState, getSessionEvents } from "./session-store";
import type { Env, AgentSession, ChatSubmittedResponse, SessionResponse, SessionState } from "./types";
import type { ChatRequest } from "./public-types";

// Export the Datastore Durable Object class and Workflow
export { ClawflareDatastore, HttpGateway, ClawflareSessionStore, Workflow, ClawflareWebSocketSession };

// Export types for clients (from public-types.ts to avoid Workers types)
export type { 
  AgentMessage,
  SessionEvent,
  SessionState,
  SessionResponse,
  ChatSubmittedResponse,
  ChatRequest,
  AgentSession,
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
async function handleSessionChat(request: Request, env: Env): Promise<Response> {
  const requestStart = timingStart();
  let sessionId: string | undefined;

  try {
    logTiming(env, sessionId, "chat.request.start");
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
      maxTurns: body.maxTurns,
    });
    
    const initialEventCursor = await getLatestEventCursor(env, sessionId);

    // Initialize session state for polling
    const initialState: SessionState = {
      id: sessionId,
      status: "processing",
      messages: [],
      nextEventCursor: initialEventCursor,
      updatedAt: Date.now(),
    };
    const saveStateStart = timingStart();
    await saveSessionState(env, initialState);
    logTiming(env, sessionId, "chat.session_state.saved", saveStateStart);

    // Start the workflow (implementation detail, not exposed to client)
    const workflowCreateStart = timingStart();
    await startAgentWorkflow(env, { ...body, sessionId });
    logTiming(env, sessionId, "chat.workflow.create.returned", workflowCreateStart, {
      totalRequestElapsedMs: Date.now() - requestStart,
    });

    const response: ChatSubmittedResponse = {
      sessionId,
      eventCursor: initialState.nextEventCursor,
    };

    logTiming(env, sessionId, "chat.response.returning", requestStart);
    return new Response(JSON.stringify(response), {
      headers: { "Content-Type": "application/json" },
    });
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
