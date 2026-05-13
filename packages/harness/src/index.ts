// Clawflare Harness - Main Worker Entry Point
// This runs in Cloudflare Workers and provides an agent powered by pi-agent-core

import { createAgent } from "./agent";
import type { Env, ChatRequest } from "./types";

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
  async fetch(request: Request, env: Env): Promise<Response> {
    // Log all request details for debugging
    console.log(`[REQUEST] ${request.method} ${request.url}`);
    console.log(`[ENV] CLAWFLARE_API_TOKEN exists: ${!!env.CLAWFLARE_API_TOKEN}`);
    console.log(`[ENV] CLAWFLARE_API_TOKEN length: ${env.CLAWFLARE_API_TOKEN?.length || 0}`);
    
    // Validate API_TOKEN is configured
    if (!env.CLAWFLARE_API_TOKEN || env.CLAWFLARE_API_TOKEN.trim() === "") {
      console.error("[ERROR] CLAWFLARE_API_TOKEN not configured");
      return new Response(
        JSON.stringify({ error: "CLAWFLARE_API_TOKEN not configured. Set via: wrangler secret put CLAWFLARE_API_TOKEN or create a .dev.vars file" }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, ""); // Normalize trailing slash

    // Health check (no auth required for simplicity in dev)
    if (path === "/health") {
      return new Response(JSON.stringify({ status: "ok" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Authenticate all other requests
    const authError = authenticate(request, env);
    if (authError) return authError;

    // WebSocket upgrade for interactive sessions
    if (path === "/ws") {
      // Get the WebSocket pair
      const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
      
      // Handle the WebSocket connection
      handleWebSocket(server, env).catch(console.error);
      
      return new Response(null, { status: 101, webSocket: client });
    }

    // REST API endpoints
    if (path === "/v1/chat" && request.method === "POST") {
      return handleChat(request, env);
    }

    if (path === "/v1/context" && request.method === "GET") {
      return handleGetContext(env);
    }

    if (path === "/v1/context" && request.method === "POST") {
      return handleNewContext(request, env);
    }

    if (path === "/v1/skills" && request.method === "GET") {
      return handleListSkills(env);
    }

    if (path === "/v1/tools" && request.method === "GET") {
      return handleListTools(env);
    }

    // Server info endpoint (provides provider/model configuration)
    if (path === "/v1/info" && request.method === "GET") {
      return handleGetInfo(env);
    }

    // Health check (no auth required for simplicity in dev)
    if (path === "/health") {
      return new Response(JSON.stringify({ status: "ok" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  },
};

// Handle chat requests via REST API
async function handleChat(request: Request, env: Env): Promise<Response> {
  try {
    const body = (await request.json()) as ChatRequest;
    const agent = await createAgent(env);
    const response = await agent.chat(body);

    return new Response(JSON.stringify(response), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}

// Handle get context
async function handleGetContext(env: Env): Promise<Response> {
  try {
    console.log("[handleGetContext] Creating agent...");
    const agent = await createAgent(env);
    console.log("[handleGetContext] Getting context...");
    const context = await agent.getContext();
    console.log("[handleGetContext] Context retrieved successfully");
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

// Handle new context creation
async function handleNewContext(request: Request, env: Env): Promise<Response> {
  try {
    const body = (await request.json()) as { parentId?: string };
    const agent = await createAgent(env);
    const context = await agent.createContext(body.parentId);
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

// Handle list skills
async function handleListSkills(env: Env): Promise<Response> {
  try {
    const list = await env.SKILLS.list();
    const skills = await Promise.all(
      list.keys.map(async (key) => {
        const value = await env.SKILLS.get(key.name);
        return value ? JSON.parse(value) : null;
      })
    );
    return new Response(
      JSON.stringify({ skills: skills.filter(Boolean) }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}

// Handle list tools
async function handleListTools(env: Env): Promise<Response> {
  try {
    const agent = await createAgent(env);
    const tools = await agent.getTools();
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
    
    return new Response(JSON.stringify({ 
      provider, 
      model, 
      contextWindow 
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

// Handle WebSocket connections
async function handleWebSocket(ws: WebSocket, env: Env): Promise<void> {
  ws.accept();

  const agent = await createAgent(env);

  ws.addEventListener("message", async (event) => {
    try {
      const data = JSON.parse(event.data as string);
      
      if (data.type === "prompt") {
        const response = await agent.chat(data);
        ws.send(JSON.stringify(response));
      } else if (data.type === "steer") {
        const response = await agent.steer(data.content);
        ws.send(JSON.stringify({ type: "steer_ack", content: response }));
      }
    } catch (error) {
      ws.send(
        JSON.stringify({
          type: "error",
          content: error instanceof Error ? error.message : "Unknown error",
        })
      );
    }
  });

  ws.addEventListener("close", () => {
    // Cleanup if needed
  });
}