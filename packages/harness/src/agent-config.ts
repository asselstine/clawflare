import { getModel, streamSimple, type Model, setBedrockProviderModule } from "@earendil-works/pi-ai";
import { bedrockProviderModule } from "@earendil-works/pi-ai/bedrock-provider";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Env } from "./internal-types/index.js";

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
  console.log("Bedrock token", bedrockToken ? `${bedrockToken.slice(0, 2)}…${bedrockToken.slice(-2)}` : "missing");

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

  return {
    model,
    streamFn: streamSimple,
    tools: [], // Tools are created separately
    getApiKey,
  };
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
