import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "../internal-types/index.js";
import { getDataLayer } from "../data/index.js";
import { createEgressRegistry as createBaseEgressRegistry } from "./registry.js";
import type { EgressContext } from "@clawflare/egress-core";
import { getRuntimeConfig, createEgressRegistryWithConfig } from "../config-api.js";

export async function routeOutboundRequest(
  env: Env,
  request: Request,
  requestId?: string
): Promise<Response> {
  // Use config-driven registry if runtime config is available, otherwise fallback to base
  let registry;
  const runtimeConfig = getRuntimeConfig();
  if (runtimeConfig) {
    registry = createEgressRegistryWithConfig(runtimeConfig);
  } else {
    registry = createBaseEgressRegistry<Env>();
  }

  const data = getDataLayer(env);
  const metadata = await data.egressHandlers.list(true);

  // Build a set of handler names that have D1 metadata
  const metadataNames = new Set(metadata.map((m) => m.name));

  // Check registered handlers first for domain-specific handling
  // First: check handlers that have D1 metadata (respects enable/disable)
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

  // Second: check registry handlers that don't have D1 metadata
  // This allows config-defined handlers to work without manual D1 setup
  for (const handler of registry.list()) {
    // Skip handlers that have metadata (already checked above)
    if (metadataNames.has(handler.name)) continue;

    if (!handler.fetch) continue;

    const context: EgressContext<Env> = {
      env,
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
