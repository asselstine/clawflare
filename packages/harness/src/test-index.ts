// Test-only Worker entrypoint.
// This file is used by wrangler.test.jsonc and is not imported by the production Worker.

import productionWorker, { ClawflareDatastore, HttpGateway, ClawflareAgentWorkflow } from "./index";
import { getDatastore } from "./datastore";
import { routeOutboundRequest } from "./egress/gateway";
import { executeDynamicWorker } from "./runtime/dynamic-worker";
import type { Env } from "./types";

export { ClawflareDatastore, HttpGateway, ClawflareAgentWorkflow };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, "");

    if (path.startsWith("/__test/")) {
      const authError = authenticate(request, env);
      if (authError) return authError;
      return handleTestEndpoint(path, request, env, ctx);
    }

    return productionWorker.fetch(request, env, ctx);
  },
};

function getToken(request: Request): string | null {
  const auth = request.headers.get("Authorization");
  if (!auth || !auth.startsWith("Bearer ")) return null;
  return auth.slice(7);
}

function authenticate(request: Request, env: Env): Response | null {
  const token = getToken(request);
  if (!token || token !== env.CLAWFLARE_API_TOKEN) {
    return json({ error: "Unauthorized" }, 401);
  }
  return null;
}

async function handleTestEndpoint(
  path: string,
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  try {
    if (path === "/__test/execute-code" && request.method === "POST") {
      const body = (await request.json()) as { code: string; input?: unknown; allowOutbound?: boolean };
      const result = await executeDynamicWorker(env, ctx, body.code, body.input, {
        allowOutbound: body.allowOutbound ?? true,
      });
      return json(result);
    }

    if (path === "/__test/store-code" && request.method === "POST") {
      const body = (await request.json()) as { name: string; description?: string; code: string };
      const stored = await getDatastore(env).upsertStoredCode({
        name: body.name,
        description: body.description || "",
        code: body.code,
      });
      return json({ ok: true, stored: { ...stored, code: undefined } });
    }

    if (path === "/__test/execute-stored-code" && request.method === "POST") {
      const body = (await request.json()) as { name: string; input?: unknown };
      const stored = await getDatastore(env).getStoredCode(body.name);
      if (!stored) return json({ ok: false, error: `Code ${body.name} not found` }, 404);
      return json(await executeDynamicWorker(env, ctx, stored.code, body.input));
    }

    if (path === "/__test/egress-fetch" && request.method === "POST") {
      const body = (await request.json()) as { url: string };
      const outboundResponse = await routeOutboundRequest(env, new Request(body.url), crypto.randomUUID());
      const responseBody = await outboundResponse.text();
      return json({
        ok: true,
        status: outboundResponse.status,
        body: responseBody ? JSON.parse(responseBody) : null,
      });
    }

    if (path === "/__test/search" && request.method === "GET") {
      const url = new URL(request.url);
      const collection = (url.searchParams.get("collection") || "all") as "stored_code" | "egress_handlers" | "all";
      const query = url.searchParams.get("q") || undefined;
      const results = await getDatastore(env).search(collection, query, 20);
      return json({ ok: true, results });
    }

    return json({ error: "Not found" }, 404);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
