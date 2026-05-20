// Worker Environment types - Cloudflare Workers bindings
// These types are NOT exported publicly and can only be used in Workers code

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
  // API token for authentication
  CLAWFLARE_API_TOKEN: string;

  // D1 Database - Primary persistent storage
  DB: D1Database;

  // Durable Objects
  // WebSocket session Durable Object
  WEBSOCKET_SESSION: DurableObjectNamespace;

  // Service binding to the HttpGateway entrypoint for Dynamic Worker egress
  HTTP_GATEWAY: Fetcher;

  // Worker Loader for Dynamic Worker execution
  LOADER: WorkerLoader;

  // Workflow for durable agent execution
  AGENT_WORKFLOW: Workflow;

  // Cloudflare API credentials
  CLOUDFLARE_API_TOKEN: string;
  CLOUDFLARE_ACCOUNT_ID: string;

  // GitHub token (optional)
  GITHUB_TOKEN?: string;

  // AI Provider configuration
  AI_PROVIDER: string;
  AI_MODEL?: string;
  MOCK_AI?: string;

  // AWS Bedrock settings
  AWS_BEARER_TOKEN_BEDROCK?: string;
  AWS_REGION?: string;
  AWS_PROFILE?: string;

  // Optional provider API keys for non-default AI providers
  ANTHROPIC_OAUTH_TOKEN?: string;
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  AZURE_OPENAI_API_KEY?: string;
  DEEPSEEK_API_KEY?: string;
  GEMINI_API_KEY?: string;
  GOOGLE_CLOUD_API_KEY?: string;
  GROQ_API_KEY?: string;
  CEREBRAS_API_KEY?: string;
  XAI_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  AI_GATEWAY_API_KEY?: string;
  ZAI_API_KEY?: string;
  MISTRAL_API_KEY?: string;
  MINIMAX_API_KEY?: string;
  MINIMAX_CN_API_KEY?: string;
  MOONSHOT_API_KEY?: string;
  HF_TOKEN?: string;
  FIREWORKS_API_KEY?: string;
  OPENCODE_API_KEY?: string;
  KIMI_API_KEY?: string;
  CLOUDFLARE_API_KEY?: string;
  XIAOMI_API_KEY?: string;
  XIAOMI_TOKEN_PLAN_CN_API_KEY?: string;
  XIAOMI_TOKEN_PLAN_AMS_API_KEY?: string;
  XIAOMI_TOKEN_PLAN_SGP_API_KEY?: string;

  // Debug settings
  CLAWFLARE_DEBUG_TIMING?: string;
}
