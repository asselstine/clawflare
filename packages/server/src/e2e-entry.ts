// Test entry point with additional test endpoints
// This is used for E2E testing

import { HttpGateway, routeOutboundRequest } from "./egress/gateway.js";
import { PersistentSessionWorkflow } from "./workflow.js";
import { ClawflareWebSocketSession } from "./ws-session.js";
import { CodingContainer, ContainerProxy } from "./container/coding-container.js";
import type { Env } from "./internal-types/index.js";
import { getDataLayer } from "./data/index.js";
import { executeDynamicWorker } from "./tools/dynamic-worker.js";
import { containerBash, containerLs, destroyContainer, getContainerHealth } from "./container/client.js";
import { createAccessToken } from "./auth/access-tokens.js";

export { HttpGateway, PersistentSessionWorkflow, ClawflareWebSocketSession, CodingContainer, ContainerProxy };

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function retryContainerTestCall<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < 3) await sleep(1000 * attempt);
    }
  }
  throw lastError;
}

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
      await getDataLayer(env).storedCode.upsert({
        workspaceId: "default-workspace",
        name: body.name,
        code: body.code,
        description: body.description,
        tags: body.tags,
      });
      return Response.json({ ok: true });
    }

    if (path === "/__test/search" && request.method === "GET") {
      const query = url.searchParams.get("q") || "*";
      const results = await getDataLayer(env).search("default-workspace", query, 20);
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
      const entry = await getDataLayer(env).storedCode.get("default-workspace", body.name);
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

    // Create access token for E2E tests (allows login-based auth flow)
    if (path === "/__test/create-access-token" && request.method === "POST") {
      const body = await request.json<{ userId?: string; name?: string; clientName?: string }>();
      const result = await createAccessToken(env, {
        userId: body.userId || "e2e-test-user",
        name: body.name || "E2E Test Token",
        clientName: body.clientName || "e2e-test-client",
      });
      if (!result) {
        return Response.json({ ok: false, error: "Failed to create access token" }, { status: 500 });
      }
      return Response.json({ ok: true, token: result.token, tokenId: result.id });
    }

    // Container test endpoints
    if (path === "/__test/container-create" && request.method === "POST") {
      try {
        const body = await request.json<{ containerId?: string }>();
        const containerId = body.containerId || `e2e-test-${Date.now()}`;
        const health = await retryContainerTestCall(() => getContainerHealth(env, containerId));
        return Response.json({ ok: true, containerId, status: health.status });
      } catch (error) {
        return Response.json({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }, { status: 500 });
      }
    }

    if (path === "/__test/container-bash" && request.method === "POST") {
      try {
        const body = await request.json<{ containerId: string; command: string; cwd?: string }>();
        const result = await retryContainerTestCall(() => containerBash(env, body.containerId, body.command, body.cwd));
        return Response.json({ ok: result.ok, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr });
      } catch (error) {
        return Response.json({
          ok: false,
          exitCode: null,
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
        }, { status: 500 });
      }
    }

    if (path === "/__test/container-destroy" && request.method === "POST") {
      try {
        const body = await request.json<{ containerId: string }>();
        await destroyContainer(env, body.containerId);
        return Response.json({ ok: true, containerId: body.containerId });
      } catch (error) {
        return Response.json({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }, { status: 500 });
      }
    }

    if (path === "/__test/container-ls" && request.method === "POST") {
      try {
        const body = await request.json<{ containerId: string; path?: string }>();
        const result = await retryContainerTestCall(() => containerLs(env, body.containerId, body.path));
        return Response.json({ ok: result.ok, entries: result.entries, entryCount: result.entryCount });
      } catch (error) {
        return Response.json({
          ok: false,
          entries: [],
          entryCount: 0,
          error: error instanceof Error ? error.message : String(error),
        }, { status: 500 });
      }
    }

    // Delegate to main handler for other endpoints
    const main = await import("./index.js");
    return main.default.fetch(request, env, ctx);
  },
};
