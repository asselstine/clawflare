// Test entry point with additional test endpoints
// This is used for E2E testing

import { HttpGateway, routeOutboundRequest } from "./egress/gateway.js";
import { PersistentSessionWorkflow } from "./persistent-workflow.js";
import { ClawflareWebSocketSession } from "./ws-session.js";
import type { Env } from "./internal-types/index.js";
import { getDataLayer } from "./data/index.js";
import { executeDynamicWorker } from "./runtime/dynamic-worker.js";

export { HttpGateway, PersistentSessionWorkflow, ClawflareWebSocketSession };

// Test endpoints
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Health check
    if (path === "/health") {
      return new Response(JSON.stringify({ status: "ok", mode: "test" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Test-only endpoints
    if (path === "/__test/reset" && request.method === "POST") {
      return new Response(JSON.stringify({ ok: true, action: "reset" }));
    }

    if (path === "/__test/store-code" && request.method === "POST") {
      const body = await request.json<{ name: string; code: string; description?: string; tags?: string[] }>();
      await getDataLayer(env).storedCode.upsert(body);
      return Response.json({ ok: true });
    }

    if (path === "/__test/search" && request.method === "GET") {
      const query = url.searchParams.get("q") || "*";
      const results = await getDataLayer(env).search(query, 20);
      return Response.json({
        ok: true,
        results: {
          storedCode: results.storedCode.map(({ code: _code, ...entry }) => entry),
          egressHandlers: results.egressHandlers,
        },
      });
    }

    if (path === "/__test/execute-stored-code" && request.method === "POST") {
      const body = await request.json<{ name: string; input?: unknown }>();
      const entry = await getDataLayer(env).storedCode.get(body.name);
      if (!entry) return Response.json({ ok: false, error: "Code not found" }, { status: 404 });
      return Response.json(await executeDynamicWorker(env, ctx, entry.code, body.input));
    }

    if (path === "/__test/execute-code" && request.method === "POST") {
      const body = await request.json<{ code: string; input?: unknown; allowOutbound?: boolean }>();
      return Response.json(await executeDynamicWorker(env, ctx, body.code, body.input, {
        allowOutbound: body.allowOutbound,
      }));
    }

    if (path === "/__test/egress-fetch" && request.method === "POST") {
      const body = await request.json<{ url: string; method?: string; headers?: Record<string, string>; body?: string }>();
      const response = await routeOutboundRequest(env, new Request(body.url, {
        method: body.method || "GET",
        headers: body.headers,
        body: body.body,
      }));
      let payload: unknown;
      try {
        payload = await response.clone().json();
      } catch {
        payload = await response.text();
      }
      return Response.json({ ok: response.ok, status: response.status, body: payload });
    }

    // Delegate to main handler for other endpoints
    const main = await import("./index.js");
    return main.default.fetch(request, env, ctx);
  },
};
