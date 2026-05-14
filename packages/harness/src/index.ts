// Clawflare Harness - Main Worker Entry Point
// This runs in Cloudflare Workers and provides an agent powered by pi-agent-core

import { ClawflareDatastore } from "./datastore";
import { HttpGateway } from "./egress/gateway";
import { Workflow, getWorkflowStatus, startAgentWorkflow } from "./workflow";
import { ClawflareWebSocketSession } from "./ws-session";
import { createTools } from "./tools";
import { normalizeBedrockBearerToken } from "./agent-config";
import type { Env, ChatRequest, AgentSession } from "./types";

// Export the Datastore Durable Object class and Workflow
export { ClawflareDatastore, HttpGateway, Workflow, ClawflareWebSocketSession };

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
    const isWorkflowPoll = request.method === "GET" && path.startsWith("/v1/workflow/");

    if (!isWorkflowPoll) {
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

    // WebSocket upgrade for interactive workflow sessions. A Durable Object owns
    // the socket so status polling survives beyond the initial Worker request.
    if (path === "/ws") {
      const id = env.WEBSOCKET_SESSION.idFromName(crypto.randomUUID());
      return env.WEBSOCKET_SESSION.get(id).fetch(request);
    }

    // REST API endpoints. Chat is workflow-backed and returns immediately with
    // a workflow instance that clients can poll via /v1/workflow/:id.
    if (path === "/v1/chat" && request.method === "POST") {
      return handleWorkflowChat(request, env);
    }

    if (path === "/v1/context" && request.method === "GET") {
      return handleGetContext(env);
    }

    if (path === "/v1/context" && request.method === "POST") {
      return handleNewContext(request, env);
    }

    if (path === "/v1/tools" && request.method === "GET") {
      return handleListTools(env, ctx);
    }

    // Server info endpoint (provides provider/model configuration)
    if (path === "/v1/info" && request.method === "GET") {
      return handleGetInfo(env);
    }

    // Workflow endpoints for durable agent execution
    if (path === "/v1/workflow/chat" && request.method === "POST") {
      return handleWorkflowChat(request, env);
    }

    if (path.startsWith("/v1/workflow/") && request.method === "GET") {
      const instanceId = path.replace("/v1/workflow/", "");
      return handleGetWorkflowStatus(instanceId, env);
    }

    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  },
};

// Handle get context - read from KV directly
async function handleGetContext(env: Env): Promise<Response> {
  try {
    const sessionId = "main"; // Default context
    const stateJson = await env.AGENT_SESSION.get(sessionId);
    const state = stateJson ? JSON.parse(stateJson) : { messages: [] };
    
    const context: AgentSession = {
      id: sessionId,
      messages: state.messages || [],
      createdAt: state.createdAt || Date.now(),
    };
    
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

// Handle new context creation - create in KV directly
async function handleNewContext(request: Request, env: Env): Promise<Response> {
  try {
    const body = (await request.json()) as { parentId?: string; };
    const sessionId = crypto.randomUUID();
    
    // Load parent context if provided
    const parentJson = body.parentId ? await env.AGENT_SESSION.get(body.parentId) : null;
    const parent = parentJson ? JSON.parse(parentJson) as AgentSession : null;
    
    const context: AgentSession = {
      id: sessionId,
      parentId: body.parentId,
      messages: parent?.messages ? [...parent.messages] : [],
      createdAt: Date.now(),
    };

    // Store in KV
    await env.AGENT_SESSION.put(sessionId, JSON.stringify(context));
    
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
        hadBearerPrefix: /^\s*Bearer\s+/i.test(rawBedrockToken),
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

async function sha256Prefix(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash))
    .slice(0, 8)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

// Handle durable workflow-based chat
async function handleWorkflowChat(request: Request, env: Env): Promise<Response> {
  try {
    const body = (await request.json()) as ChatRequest;
    
    const response = await startAgentWorkflow(env, body);
    return new Response(JSON.stringify(response), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[handleWorkflowChat] Error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    const status = message.startsWith("Invalid request.") ? 400 : 500;
    return new Response(
      JSON.stringify({ error: message }),
      { status, headers: { "Content-Type": "application/json" } }
    );
  }
}

// Handle get workflow status
async function handleGetWorkflowStatus(instanceId: string, env: Env): Promise<Response> {
  try {
    const status = await getWorkflowStatus(env, instanceId);
    return new Response(JSON.stringify(status), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
