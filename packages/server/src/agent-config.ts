import { getModel, streamSimple, type Model, setBedrockProviderModule } from "@earendil-works/pi-ai";
import { bedrockProviderModule } from "@earendil-works/pi-ai/bedrock-provider";
import type { AgentTool, StreamFn } from "@earendil-works/pi-agent-core";
import type { Env } from "./internal-types/index.js";
import type { ResolvedModelConnection } from "./model-connection-service.js";

// Eagerly register the bedrock provider module to prevent dynamic import issues in Workers
setBedrockProviderModule(bedrockProviderModule);

export interface BuildAgentComponentsResult {
  model: Model<"bedrock-converse-stream">;
  streamFn: typeof streamSimple;
  tools: AgentTool[];
  getApiKey: () => Promise<string | undefined>;
}

/**
 * Build agent components from environment.
 * Currently focused on Bedrock with minimax-m2.5 as default.
 */
export async function buildAgentComponents(env: Env): Promise<BuildAgentComponentsResult> {
  const provider = env.AI_PROVIDER || "amazon-bedrock";
  const modelId = env.AI_MODEL || "minimax.minimax-m2.5";
  const mockMode = env.MOCK_AI === "true";

  // Normalize bedrock token if present
  const bedrockToken = normalizeBedrockBearerToken(env.AWS_BEARER_TOKEN_BEDROCK) || "";
  // Log partial token for debugging, never log full token
  // Token logging removed for security

  // Create getApiKey function for the provider
  const getApiKey = async () => {
    if (mockMode) return "mock-key";
    if (provider === "amazon-bedrock") return bedrockToken;
    return undefined;
  };

  // Get the model
  const model = getModel(
    provider as "amazon-bedrock",
    modelId as "minimax.minimax-m2.5"
  ) as unknown as Model<"bedrock-converse-stream">;

  const streamFn = ((requestModel: Model<any>, context: any, options?: any) => {
    if (provider === "amazon-bedrock") {
      const bearerToken = options?.bearerToken || options?.apiKey || bedrockToken || undefined;
      return bedrockProviderModule.streamBedrock(requestModel as Model<"bedrock-converse-stream">, context, {
        ...options,
        bearerToken,
        maxTokens: options?.maxTokens ?? (requestModel.maxTokens > 0 ? Math.min(requestModel.maxTokens, 32000) : undefined),
      });
    }
    return streamSimple(requestModel, context, options);
  }) as StreamFn as typeof streamSimple;

  return {
    model,
    streamFn,
    tools: [], // Tools are created separately
    getApiKey,
  };
}

/**
 * Build agent components from a resolved model connection.
 * Uses the model connection's provider, model, and secrets.
 */
export async function buildAgentComponentsFromResolved(
  env: Env,
  resolved: ResolvedModelConnection
): Promise<BuildAgentComponentsResult> {
  const mockMode = env.MOCK_AI === "true";
  const provider = resolved.provider;
  const modelId = resolved.modelName;

  // Create getApiKey function using resolved secrets
  const getApiKey = async (): Promise<string | undefined> => {
    if (mockMode) return "mock-key";
    
    // Map provider to the appropriate secret key
    const secretKey = getProviderSecretKey(provider);
    if (secretKey && secretKey in resolved.secrets) {
      return resolved.secrets[secretKey];
    }
    
    // Fallback to env vars
    return getEnvSecret(env, provider);
  };

  // Get the model - only bedrock is fully typed in current implementation
  const model = getModel(
    provider as "amazon-bedrock",
    modelId as "minimax.minimax-m2.5"
  ) as unknown as Model<"bedrock-converse-stream">;

  const streamFn = ((requestModel: Model<any>, context: any, options?: any) => {
    if (provider === "amazon-bedrock") {
      const bearerToken = options?.bearerToken || options?.apiKey || getApiKeySync(resolved) || undefined;
      return bedrockProviderModule.streamBedrock(requestModel as Model<"bedrock-converse-stream">, context, {
        ...options,
        bearerToken,
        maxTokens: options?.maxTokens ?? (requestModel.maxTokens > 0 ? Math.min(requestModel.maxTokens, 32000) : undefined),
      });
    }
    return streamSimple(requestModel, context, options);
  }) as StreamFn as typeof streamSimple;

  return {
    model,
    streamFn,
    tools: [], // Tools are created separately
    getApiKey,
  };
}

/**
 * Helper to get API key synchronously for bedrock streaming.
 * This is a temporary workaround - proper implementation would
 * handle async secret resolution differently.
 */
function getApiKeySync(resolved: ResolvedModelConnection): string | undefined {
  if (resolved.provider === "amazon-bedrock") {
    return resolved.secrets["AWS_BEARER_TOKEN_BEDROCK"] || undefined;
  }
  if (resolved.provider === "anthropic") {
    return resolved.secrets["ANTHROPIC_API_KEY"] || undefined;
  }
  if (resolved.provider === "openai") {
    return resolved.secrets["OPENAI_API_KEY"] || undefined;
  }
  return undefined;
}

/**
 * Get the expected secret key for a provider.
 */
function getProviderSecretKey(provider: string): string | undefined {
  const keyMap: Record<string, string> = {
    "amazon-bedrock": "AWS_BEARER_TOKEN_BEDROCK",
    "anthropic": "ANTHROPIC_API_KEY",
    "openai": "OPENAI_API_KEY",
  };
  return keyMap[provider];
}

/**
 * Get secret from environment variables as fallback.
 */
function getEnvSecret(env: Env, provider: string): string | undefined {
  const keyMap: Record<string, keyof Env> = {
    "amazon-bedrock": "AWS_BEARER_TOKEN_BEDROCK",
    "anthropic": "ANTHROPIC_API_KEY",
    "openai": "OPENAI_API_KEY",
  };
  const key = keyMap[provider];
  if (key) {
    const value = env[key];
    return typeof value === "string" ? value : undefined;
  }
  return undefined;
}

/**
 * Normalize Bedrock bearer token - remove "Bearer " prefix if present.
 */
export function normalizeBedrockBearerToken(token: string | undefined): string | undefined {
  if (!token) return undefined;
  return token.replace(/^\s*Bearer\s+/i, "").trim() || undefined;
}

/**
 * Create streaming function for Bedrock.
 */
export async function createBedrockStreaming(env: Env): Promise<typeof streamSimple> {
  const components = await buildAgentComponents(env);
  return components.streamFn;
}
