import { getModel, streamSimple, type Model, setBedrockProviderModule } from "@earendil-works/pi-ai";
import { bedrockProviderModule } from "@earendil-works/pi-ai/bedrock-provider";
import type { AgentTool, StreamFn } from "@earendil-works/pi-agent-core";
import type { ResolvedModelConnection } from "../modules/model-connections/model-connections.service.js";
import { MOCK_AI_PROVIDER, MOCK_AI_MODEL } from "./mock-ai.js";

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
 * DEPRECATED: Use buildAgentComponentsFromResolved with a model connection instead.
 * This function only works if env vars are set, which is no longer the default.
 * @deprecated
 */
export async function buildAgentComponents(): Promise<BuildAgentComponentsResult> {
  const provider = MOCK_AI_PROVIDER;
  const modelId = MOCK_AI_MODEL;

  // Create getApiKey function - only returns mock key, real keys must come from model connections
  const getApiKey = async () => {
    return "mock-key";
  };

  // Get the model
  const model = getModel(
    provider as "amazon-bedrock",
    modelId as "minimax.minimax-m2.5"
  ) as unknown as Model<"bedrock-converse-stream">;

  const streamFn = ((requestModel: Model<any>, context: any, options?: any) => {
    if (provider === "amazon-bedrock") {
      const bearerToken = options?.bearerToken || options?.apiKey || undefined;
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
  resolved: ResolvedModelConnection
): Promise<BuildAgentComponentsResult> {
  const provider = resolved.provider;
  const modelId = resolved.modelName;

  // Create getApiKey function using resolved secrets
  const getApiKey = async (): Promise<string | undefined> => {
    // Map provider to the appropriate secret key
    const secretKey = getProviderSecretKey(provider);
    if (secretKey && secretKey in resolved.secrets) {
      return resolved.secrets[secretKey];
    }
    
    return undefined;
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
 * Normalize Bedrock bearer token - remove "Bearer " prefix if present.
 */
export function normalizeBedrockBearerToken(token: string | undefined): string | undefined {
  if (!token) return undefined;
  return token.replace(/^\s*Bearer\s+/i, "").trim() || undefined;
}

/**
 * Create streaming function for Bedrock.
 * DEPRECATED: Use buildAgentComponentsFromResolved with a model connection instead.
 * @deprecated
 */
export async function createBedrockStreaming(): Promise<typeof streamSimple> {
  const components = await buildAgentComponents();
  return components.streamFn;
}
