export type EgressLogContext = Record<string, unknown>;

export interface EgressLogger {
  debug?: (message: string, context?: EgressLogContext) => void;
  info: (message: string, context?: EgressLogContext) => void;
  warn: (message: string, context?: EgressLogContext) => void;
  error?: (message: string, error?: unknown, context?: EgressLogContext) => void;
}

export interface EgressContext<Env = unknown> {
  env: Env;
  handlerConfig?: unknown;
  logger: EgressLogger;
  requestId?: string;
}

export interface EgressHandler<Env = unknown> {
  name: string;
  description: string;
  domains: string[];

  handles(request: Request, context: EgressContext<Env>): boolean | Promise<boolean>;
  fetch?(request: Request, context: EgressContext<Env>): Promise<Response>;
  connect?(socket: unknown, context: EgressContext<Env>): void | Promise<void>;
}

export class EgressRegistry<Env = unknown> {
  private handlers = new Map<string, EgressHandler<Env>>();

  register(handler: EgressHandler<Env>): void {
    this.handlers.set(handler.name, handler);
  }

  get(name: string): EgressHandler<Env> | undefined {
    return this.handlers.get(name);
  }

  list(): EgressHandler<Env>[] {
    return Array.from(this.handlers.values());
  }
}

export function hostnameMatchesDomain(hostname: string, domain: string): boolean {
  const normalizedHost = hostname.toLowerCase();
  const normalizedDomain = domain.toLowerCase();
  return normalizedHost === normalizedDomain || normalizedHost.endsWith(`.${normalizedDomain}`);
}

// =============================================================================
// HTTP Egress Handler Factory
// =============================================================================

/**
 * Configuration for creating an HTTP egress handler
 */
export interface DefineHttpEgressHandlerConfig<Env = unknown> {
  name: string;
  description: string;
  domains: string[];
  /**
   * Mock mode handler - called when env.MOCK_EGRESS === "true"
   */
  mock?: (request: Request, context: HttpEgressHandlerContext<Env>) => Response | Promise<Response>;
  /**
   * Decorates headers before the request is made
   */
  decorateHeaders?: (headers: Headers, request: Request, context: HttpEgressHandlerContext<Env>) => void | Promise<void>;
}

/**
 * Context for HTTP egress handlers created with defineHttpEgressHandler
 */
export interface HttpEgressHandlerContext<Env = unknown> {
  env: Env & { MOCK_EGRESS?: string };
  handlerConfig?: unknown;
  logger: EgressLogger;
  requestId?: string;
}

/**
 * Creates a standard HTTP egress handler with common boilerplate
 * including domain matching, mock mode support, and header decoration.
 */
export function defineHttpEgressHandler<Env = unknown>(
  config: DefineHttpEgressHandlerConfig<Env>
): EgressHandler<Env> {
  return {
    name: config.name,
    description: config.description,
    domains: config.domains,

    handles(request: Request): boolean {
      const hostname = new URL(request.url).hostname;
      return config.domains.some((domain) => hostnameMatchesDomain(hostname, domain));
    },

    async fetch(request: Request, context: HttpEgressHandlerContext<Env>): Promise<Response> {
      // Mock mode support
      if (context.env.MOCK_EGRESS === "true") {
        if (config.mock) {
          return config.mock(request, context);
        }
        return Response.json({ ok: true, handler: config.name, url: request.url });
      }

      const headers = new Headers(request.headers);

      // Apply header decorations
      if (config.decorateHeaders) {
        await config.decorateHeaders(headers, request, context);
      }

      return fetch(new Request(request, { headers }));
    },
  };
}

// =============================================================================
// Simplified Egress Handler Factory
// =============================================================================

/**
 * Human-friendly configuration for creating an egress handler.
 * This provides a simpler API than the full EgressHandler interface.
 */
export interface DefineEgressHandlerConfig<Env = unknown> {
  name: string;
  description: string;
  domains: string[];
  /**
   * Check if this handler should handle the request.
   * If not provided, uses domain matching.
   */
  handles?: (request: Request, context: EgressContext<Env>) => boolean | Promise<boolean>;
  /**
   * Fetch the request. Required for HTTP handlers.
   */
  fetch: (request: Request, context: EgressContext<Env>) => Promise<Response>;
}

/**
 * Define a custom egress handler with a simpler API.
 * This wraps the lower-level EgressHandler interface for easier use.
 */
export function defineEgressHandler<Env = unknown>(
  config: DefineEgressHandlerConfig<Env>
): EgressHandler<Env> {
  return {
    name: config.name,
    description: config.description,
    domains: config.domains,

    handles(request: Request, context: EgressContext<Env>): boolean | Promise<boolean> {
      if (config.handles) {
        return config.handles(request, context);
      }
      // Default: domain matching
      const hostname = new URL(request.url).hostname;
      return config.domains.some((domain) => hostnameMatchesDomain(hostname, domain));
    },

    fetch: config.fetch,
  };
}
