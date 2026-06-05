/**
 * Coding Container - Cloudflare Container subclass for Clawflare
 *
 * Provides an isolated development environment with:
 * - MITM HTTPS interception for egress control
 * - Outbound request routing through Clawflare's egress gateway
 * - Workspace isolation at /workspace
 */

import { Container, ContainerProxy } from "@cloudflare/containers";
import type { Env } from "../../../internal-types/index.js";
import { routeOutboundRequest } from "../../../egress/gateway.js";
import { ContainerRepository } from "../../../data/index.js";

// Required for outbound interception to work.
export { ContainerProxy };

// Outbound request handler - routes through Clawflare egress system
interface CodingContainerOutboundParams {
  containerId?: string;
}

const codingContainerOutbound = async (
  request: Request,
  env: Env,
  ctx: { containerId?: string; params?: unknown }
): Promise<Response> => {
  // Pass container ID as request ID for egress logging/tracking
  const params = ctx?.params as CodingContainerOutboundParams | undefined;
  const containerId = params?.containerId ?? ctx?.containerId;
  const requestId = containerId ? `container:${containerId}` : "container:unknown";
  if (!containerId) {
    return new Response("Container outbound request is missing a container ID.", {
      status: 500,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  const containers = new ContainerRepository(env.DB);
  const container = await containers.getById(containerId);
  if (!container) {
    return new Response(`Container outbound request has no D1 record for ${containerId}.`, {
      status: 500,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
  if (container.status !== "active" || container.deletedAt !== undefined) {
    return new Response(`Container outbound request is for removed container ${containerId}.`, {
      status: 410,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
  const [sessionLink] = await containers.listLinksForContainerId(containerId);
  if (!sessionLink) {
    return new Response(`Container outbound request has no session link for ${containerId}.`, {
      status: 500,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  return routeOutboundRequest(env, request, requestId, {
    workspaceId: container.workspaceId,
    auth: { type: "session", sessionId: sessionLink.sessionId },
  });
};

/**
 * Coding Container class
 *
 * This class is instantiated by Cloudflare's Container runtime.
 * The static outbound handler is called for egress requests.
 */
export class CodingContainer extends Container<Env> {
  static {
    // Assign through the base accessor so @cloudflare/containers registers the handler.
    this.outbound = codingContainerOutbound;
    this.outboundHandlers = {
      clawflare: codingContainerOutbound,
    };
  }

  defaultPort = 8080;
  requiredPorts = [8080];
  sleepAfter = "20m";
  enableInternet = false;
  interceptHttps = true;

  envVars = {
    WORKSPACE_ROOT: "/workspace",
    // CA certificates for MITM HTTPS interception
    NODE_EXTRA_CA_CERTS: "/etc/cloudflare/certs/cloudflare-containers-ca.crt",
    REQUESTS_CA_CERTS: "/etc/cloudflare/certs/cloudflare-containers-ca.crt",
    SSL_CERT_FILE: "/etc/cloudflare/certs/cloudflare-containers-ca.crt",
    GIT_SSL_CAINFO: "/etc/cloudflare/certs/cloudflare-containers-ca.crt",
    // Git/libcurl can report GnuTLS premature-termination errors when smart HTTP
    // negotiates HTTP/2 through Cloudflare's intercepted HTTPS path.
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.version",
    GIT_CONFIG_VALUE_0: "HTTP/1.1",
  };
}
