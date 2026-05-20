// Test entry point with additional test endpoints
// This is used for E2E testing

import { ClawflareDatastore } from "./datastore.js";
import { HttpGateway } from "./egress/gateway.js";
import { ClawflareSessionStore } from "./session-do.js";
import { PersistentSessionWorkflow } from "./persistent-workflow.js";
import { ClawflareWebSocketSession } from "./ws-session.js";
import type { Env } from "./internal-types/index.js";

export { ClawflareDatastore, HttpGateway, ClawflareSessionStore, PersistentSessionWorkflow, ClawflareWebSocketSession };

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
    if (path === "__test/reset" && request.method === "POST") {
      return new Response(JSON.stringify({ ok: true, action: "reset" }));
    }

    // Delegate to main handler for other endpoints
    const main = await import("./index.js");
    return main.default.fetch(request, env, ctx);
  },
};
