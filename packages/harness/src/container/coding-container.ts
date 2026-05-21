/**
 * Coding Container - Cloudflare Container subclass for Clawflare
 * 
 * Provides an isolated development environment with:
 * - MITM HTTPS interception for egress control
 * - Outbound request routing through Clawflare's egress gateway
 * - Workspace isolation at /workspace
 * 
 * Note: This uses Cloudflare's Container API which is available through
 * the cloudflare:containers import at runtime. The type declarations are
 * provided by @cloudflare/workers-types.
 */

import type { Env } from "../internal-types/index.js";
import { routeOutboundRequest } from "../egress/gateway.js";

// Cloudflare Container type - will be provided by the runtime
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Container = (globalThis as unknown as { Container: { new (): { [key: string]: unknown }; }; }).Container;

/**
 * Coding Container class
 * 
 * This class is instantiated by Cloudflare's Container runtime.
 * The static outbound handler is called for egress requests.
 */
export class CodingContainer {
  static defaultPort = 8080;
  static requiredPorts = [8080];
  static sleepAfter = "20m";
  static enableInternet = false;
  static interceptHttps = true;

  static envVars = {
    WORKSPACE_ROOT: "/workspace",
    // CA certificates for MITM HTTPS interception
    NODE_EXTRA_CA_CERTS: "/etc/cloudflare/certs/cloudflare-containers-ca.crt",
    REQUESTS_CA_CERTS: "/etc/cloudflare/certs/cloudflare-containers-ca.crt",
    SSL_CERT_FILE: "/etc/cloudflare/certs/cloudflare-containers-ca.crt",
    GIT_SSL_CAINFO: "/etc/cloudflare/certs/cloudflare-containers-ca.crt",
  };

  // Outbound request handler - routes through Clawflare egress system
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  static async outbound(request: Request, env: Env, ctx: { containerId?: string }): Promise<Response> {
    // Pass container ID as request ID for egress logging/tracking
    const requestId = ctx?.containerId ? `container:${ctx.containerId}` : "container:unknown";
    return routeOutboundRequest(env, request, requestId);
  }
}

// For compatibility with Cloudflare's Container API, we export the class
// The actual implementation will use the Container base class from the runtime
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const CodingContainerClass = (typeof Container !== "undefined" ? 
  class extends Container {
    static defaultPort = 8080;
    static requiredPorts = [8080];
    static sleepAfter = "20m";
    static enableInternet = false;
    static interceptHttps = true;

    static envVars = {
      WORKSPACE_ROOT: "/workspace",
      NODE_EXTRA_CA_CERTS: "/etc/cloudflare/certs/cloudflare-containers-ca.crt",
      REQUESTS_CA_CERTS: "/etc/cloudflare/certs/cloudflare-containers-ca.crt",
      SSL_CERT_FILE: "/etc/cloudflare/certs/cloudflare-containers-ca.crt",
      GIT_SSL_CAINFO: "/etc/cloudflare/certs/cloudflare-containers-ca.crt",
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    static async outbound(request: Request, env: Env, ctx: { containerId?: string }): Promise<Response> {
      const requestId = ctx?.containerId ? `container:${ctx.containerId}` : "container:unknown";
      return routeOutboundRequest(env, request, requestId);
    }
  }
  : CodingContainer
);
