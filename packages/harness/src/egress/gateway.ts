import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "../types";
import { getDatastore } from "../datastore";
import { createEgressRegistry } from "./registry";

export async function routeOutboundRequest(
  env: Env,
  request: Request,
  requestId?: string
): Promise<Response> {
  const registry = createEgressRegistry();
  const datastore = getDatastore(env);
  const metadata = await datastore.listEgressHandlers(true);

  for (const item of metadata) {
    const handler = registry.get(item.name);
    if (!handler?.fetch) continue;

    const context = {
      env,
      handlerConfig: item.config,
      requestId,
    };

    if (await handler.handles(request, context)) {
      return handler.fetch(request, context);
    }
  }

  return new Response(
    JSON.stringify({
      error: "Outbound request blocked",
      url: request.url,
    }),
    { status: 403, headers: { "Content-Type": "application/json" } }
  );
}

export class HttpGateway extends WorkerEntrypoint<Env, { requestId?: string }> {
  async fetch(request: Request): Promise<Response> {
    return routeOutboundRequest(this.env, request, this.ctx.props?.requestId);
  }

  async connect(_socket: Socket): Promise<void> {
    throw new Error("Outbound TCP connections are blocked");
  }
}
