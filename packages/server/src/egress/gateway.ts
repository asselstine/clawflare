import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "../internal-types/index.js";
import { getDataLayer } from "../data/index.js";
import { createEgressRegistry } from "./registry.js";
import type { EgressContext } from "@clawflare/egress-core";

// Default workspace for egress handlers during transition - Phase 6
const DEFAULT_WORKSPACE_ID = "default-workspace";

export async function routeOutboundRequest(
  env: Env,
  request: Request,
  requestId?: string
): Promise<Response> {
  // Use the base registry (GitHub and Cloudflare handlers only)
  // Config-driven handlers removed in Phase 4
  const registry = createEgressRegistry<Env>();

  const data = getDataLayer(env);
  // Phase 6: workspace-scoped egress handlers
  const metadata = await data.egressHandlers.list(DEFAULT_WORKSPACE_ID, true);

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
  // This allows handlers to work without manual D1 setup
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
