// Worker Environment types - Cloudflare Workers bindings
// These types are NOT exported publicly and can only be used in Workers code

// Import Container type for type-only usage
import type { Container } from "@cloudflare/containers";

// WorkerLoaderWorkerCode is defined as a module type (not global)
export interface WorkerLoaderWorkerCode {
  compatibilityDate: string;
  compatibilityFlags: string[];
  mainModule: string;
  limits: { cpuMs: number; subRequests: number };
  env: Record<string, unknown>;
  modules: Record<string, { js: string }>;
  globalOutbound?: Fetcher | null;
}

// Cloudflare Workers types are provided globally by @cloudflare/workers-types
// Additional interface augmentations
declare global {
  interface WorkerLoader {
    load(moduleCode: WorkerLoaderWorkerCode, options?: { signal?: AbortSignal }): Promise<Worker>;
  }

  interface Worker {
    getEntrypoint(): { fetch(request: Request): Promise<Response> };
  }
}

/**
 * Cloudflare Workers Environment
 * Contains all bindings, secrets, and environment variables
 */
export interface Env {
  // D1 Database - Primary persistent storage
  DB: D1Database;

  // Durable Objects
  // WebSocket session Durable Object
  WEBSOCKET_SESSION: DurableObjectNamespace;

  // Service binding to the HttpGateway entrypoint for Dynamic Worker egress
  HTTP_GATEWAY: Fetcher;

  // Worker Loader for Dynamic Worker execution
  LOADER: WorkerLoader;

  // Secret Broker service for envelope-encrypted secrets
  SECRET_BROKER: Fetcher;

  // Service binding used by Workflows to emit collected timing logs from a Worker context.
  TIMING_LOGGER?: Fetcher;

  // Cloudflare Container for isolated development environment
  CODING_CONTAINER: DurableObjectNamespace<Container<Env>>;

  // GitHub OAuth credentials for authentication
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  
  // Legacy GitHub token for egress (optional)
  GITHUB_TOKEN?: string;

  // Clawflare API token - used for Secret Broker authentication
  CLAWFLARE_API_TOKEN: string;

  // AWS region setting (optional, for Bedrock)
  AWS_REGION?: string;

  // Key encryption key for envelope-encrypted model connection secrets.
  // This may be a Workers secret string or an account-level Secrets Store secret binding.
  CLAWFLARE_KEK?: string | { get(): Promise<string | null> };

  // Test mode flag - enables mock AI responses when no model connection is configured
  MOCK_AI?: string;

  // Debug settings
  CLAWFLARE_DEBUG_TIMING?: string;

  // Test mode flag for E2E tests
  CLAWFLARE_TEST_RUN?: string;
}
