import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "../internal-types/index.js";
import { EgressHandlerRepository } from "../data/index.js";
import { createEgressRegistry } from "./registry.js";
import type { EgressContext } from "@clawflare/egress-core";
import { resolveEgressHandler } from "../modules/egress-handlers/egress-handlers.service.js";
import type { AuthSession } from "../modules/secrets/index.js";

// Default workspace for egress handlers during transition - Phase 6
const DEFAULT_WORKSPACE_ID = "default-workspace";

export interface HttpGatewayProps {
  requestId?: string;
  workspaceId?: string;
  sessionId?: string;
}

export async function routeOutboundRequest(
  env: Env,
  request: Request,
  requestId?: string,
  options: {
    workspaceId?: string;
    auth?: AuthSession;
  } = {}
): Promise<Response> {
  // Use the base registry (GitHub and Cloudflare handlers only)
  // Config-driven handlers removed in Phase 4
  const registry = createEgressRegistry<Env>();

  const egressHandlers = new EgressHandlerRepository(env.DB);
  const workspaceId = options.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const auth = options.auth;
  const metadata = await egressHandlers.list(workspaceId, true);

  // Build a set of handler ids that have D1 metadata.
  const metadataIds = new Set(metadata.map((m) => m.egressHandlerId));

  // Check registered handlers first for domain-specific handling
  // First: check handlers that have D1 metadata (respects enable/disable)
  for (const item of metadata) {
    const handler = registry.get(item.egressHandlerId);
    if (!handler?.fetch) continue;

    const resolved = await resolveEgressHandler(env, auth, item);
    const handlerConfig = resolved.metadata.config as Record<string, unknown> | undefined;
    const context: EgressContext<Env> = {
      env: { ...env, ...(handlerConfig ?? {}), ...resolved.secrets },
      handlerConfig,
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
    if (metadataIds.has(handler.name)) continue;

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

export class HttpGateway extends WorkerEntrypoint<Env, HttpGatewayProps> {
  async fetch(request: Request): Promise<Response> {
    return routeOutboundRequest(this.env, request, this.ctx.props?.requestId, {
      workspaceId: this.ctx.props?.workspaceId,
      auth: this.ctx.props?.sessionId
        ? { type: "session", sessionId: this.ctx.props.sessionId }
        : undefined,
    });
  }

  async connect(_socket: Socket): Promise<void> {
    throw new Error("Outbound TCP connections are blocked");
  }
}
