import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "../internal-types/index.js";
import { getDataLayer } from "../data/index.js";
import { createEgressRegistry } from "./registry.js";
import type { EgressContext } from "@clawflare/egress-core";

export async function routeOutboundRequest(
  env: Env,
  request: Request,
  requestId?: string
): Promise<Response> {
  const registry = createEgressRegistry<Env>();
  const data = getDataLayer(env);
  const metadata = await data.egressHandlers.list(true);

  // Check registered handlers first for domain-specific handling
  for (const item of metadata) {
    const handler = registry.get(item.name);
    if (!handler?.fetch) continue;

    const context: EgressContext<Env> = {
      env,
      handlerConfig: item.config as Record<string, unknown> | undefined,
      requestId,
    };

    if (await handler.handles(request, context)) {
      return handler.fetch(request, context);
    }
  }

  return fetch(request);
}

export class HttpGateway extends WorkerEntrypoint<Env, { requestId?: string }> {
  async fetch(request: Request): Promise<Response> {
    return routeOutboundRequest(this.env, request, this.ctx.props?.requestId);
  }

  async connect(_socket: Socket): Promise<void> {
    throw new Error("Outbound TCP connections are blocked");
  }
}
