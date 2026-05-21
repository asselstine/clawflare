/**
 * Coding Container - Cloudflare Container subclass for Clawflare
 *
 * Provides an isolated development environment with:
 * - MITM HTTPS interception for egress control
 * - Outbound request routing through Clawflare's egress gateway
 * - Workspace isolation at /workspace
 */

import { Container, ContainerProxy } from "@cloudflare/containers";
import type { Env } from "../internal-types/index.js";
import { routeOutboundRequest } from "../egress/gateway.js";

// Required for outbound interception to work.
export { ContainerProxy };

// Outbound request handler - routes through Clawflare egress system
const codingContainerOutbound = async (
  request: Request,
  env: Env,
  ctx: { containerId?: string }
): Promise<Response> => {
  // Pass container ID as request ID for egress logging/tracking
  const requestId = ctx?.containerId ? `container:${ctx.containerId}` : "container:unknown";
  return routeOutboundRequest(env, request, requestId);
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
  };
}
