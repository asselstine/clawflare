// Shared agent configuration and utilities for Clawflare
// Extracted from agent.ts and workflow-agent.ts to eliminate duplication

import { getModel, getProviders, streamSimple, type Api, type Model, type BedrockOptions } from "@earendil-works/pi-ai";
import type { Env } from "./types";
import { createMockStream, shouldUseMockAI } from "./mock-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";

// Default provider and model configuration
export const DEFAULT_PROVIDER: "amazon-bedrock" = "amazon-bedrock";
export const DEFAULT_MODEL_ID: "minimax.minimax-m2.5" = "minimax.minimax-m2.5";

export type BuildAgentComponentsResult = {
  model: Model<Api>;
  streamFn: typeof streamSimple;
  tools: AgentTool[];
  getApiKey: (provider?: string) => Promise<string | undefined>;
};

export function resolveConfiguredModel(env: Env): { provider: string; modelId: string; model: Model<Api> } {
  const provider = env.AI_PROVIDER || DEFAULT_PROVIDER;
  const modelId = env.AI_MODEL || DEFAULT_MODEL_ID;

  if (!getProviders().includes(provider as never)) {
    throw new Error(`Unknown AI_PROVIDER: ${provider}`);
  }

  const model = getModel(provider as never, modelId as never) as Model<Api> | undefined;
  if (!model) {
    throw new Error(`Model not found: ${provider}/${modelId}`);
  }

  return { provider, modelId, model };
}

export function normalizeBedrockBearerToken(token: string | undefined): string | undefined {
  const trimmed = token?.trim();
  if (!trimmed) return undefined;
  const unquoted = trimmed.replace(/^(?:["'])(.*)(?:["'])$/, "$1").trim();
  return unquoted.replace(/^Bearer\s+/i, "").trim() || undefined;
}

export function getApiKeyForProvider(env: Env, provider: string): string | undefined {
  switch (provider) {
    case "amazon-bedrock":
      return normalizeBedrockBearerToken(env.AWS_BEARER_TOKEN_BEDROCK);
    case "anthropic":
      return env.ANTHROPIC_OAUTH_TOKEN || env.ANTHROPIC_API_KEY;
    case "openai":
      return env.OPENAI_API_KEY;
    case "azure-openai-responses":
      return env.AZURE_OPENAI_API_KEY;
    case "deepseek":
      return env.DEEPSEEK_API_KEY;
    case "google":
      return env.GEMINI_API_KEY;
    case "google-vertex":
      return env.GOOGLE_CLOUD_API_KEY;
    case "groq":
      return env.GROQ_API_KEY;
    case "cerebras":
      return env.CEREBRAS_API_KEY;
    case "xai":
      return env.XAI_API_KEY;
    case "openrouter":
      return env.OPENROUTER_API_KEY;
    case "vercel-ai-gateway":
      return env.AI_GATEWAY_API_KEY;
    case "zai":
      return env.ZAI_API_KEY;
    case "mistral":
      return env.MISTRAL_API_KEY;
    case "minimax":
      return env.MINIMAX_API_KEY;
    case "minimax-cn":
      return env.MINIMAX_CN_API_KEY;
    case "moonshotai":
    case "moonshotai-cn":
      return env.MOONSHOT_API_KEY;
    case "huggingface":
      return env.HF_TOKEN;
    case "fireworks":
      return env.FIREWORKS_API_KEY;
    case "opencode":
    case "opencode-go":
      return env.OPENCODE_API_KEY;
    case "kimi-coding":
      return env.KIMI_API_KEY;
    case "cloudflare-workers-ai":
    case "cloudflare-ai-gateway":
      return env.CLOUDFLARE_API_KEY || env.CLOUDFLARE_API_TOKEN;
    case "xiaomi":
      return env.XIAOMI_API_KEY;
    case "xiaomi-token-plan-cn":
      return env.XIAOMI_TOKEN_PLAN_CN_API_KEY;
    case "xiaomi-token-plan-ams":
      return env.XIAOMI_TOKEN_PLAN_AMS_API_KEY;
    case "xiaomi-token-plan-sgp":
      return env.XIAOMI_TOKEN_PLAN_SGP_API_KEY;
    default:
      return undefined;
  }
}

export async function createBedrockStreaming(env: Env): Promise<typeof streamSimple> {
  const { bedrockProviderModule } = await import("@earendil-works/pi-ai/bedrock-provider");
  const { streamBedrock } = bedrockProviderModule;

  const bearerToken = normalizeBedrockBearerToken(env.AWS_BEARER_TOKEN_BEDROCK);
  
  return ((m: Model<"bedrock-converse-stream">, ctx: Parameters<typeof streamSimple>[1], opts?: BedrockOptions) => {
    const bedrockOptions: BedrockOptions = {
      ...opts,
      bearerToken,
      apiKey: bearerToken,
      region: env.AWS_REGION || "us-east-1",
      profile: env.AWS_PROFILE,
    };
    return streamBedrock(m, ctx, bedrockOptions);
  }) as typeof streamSimple;
}

export async function buildAgentComponents(
  env: Env,
  execCtx?: ExecutionContext
): Promise<{
  model: Model<Api>;
  streamFn: typeof streamSimple;
  tools: import("@earendil-works/pi-agent-core").AgentTool[];
  getApiKey: (provider?: string) => Promise<string | undefined>;
}> {
  const { createTools } = await import("./tools");
  const { provider, model } = resolveConfiguredModel(env);
  const tools = createTools(env, execCtx);
  const useMock = shouldUseMockAI(env);
  const streamFn = useMock
    ? createMockStream()
    : provider === "amazon-bedrock"
      ? await createBedrockStreaming(env)
      : streamSimple;
  const getApiKey = (requestedProvider?: string): Promise<string | undefined> => {
    return Promise.resolve(getApiKeyForProvider(env, requestedProvider || provider));
  };

  return { model, streamFn: streamFn as typeof streamSimple, tools, getApiKey };
}

export function getSystemPrompt(): string {
  return `You are Clawflare, an AI agent that runs on Cloudflare's platform.

Prefer storing reusable code when it will save tokens in future turns.
Be helpful, concise, and focus on getting tasks done efficiently.`;
}
