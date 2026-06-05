import { getModel, getModels, getProviders } from "@earendil-works/pi-ai";

export interface ProviderDefinition {
  provider: string;
  requiredSecrets: string[];
  optionalSecrets: string[];
  configSchema: Record<string, unknown>;
  defaultModel?: string;
}

const PROVIDER_SECRET_DEFINITIONS: Record<string, Pick<ProviderDefinition, "requiredSecrets" | "optionalSecrets" | "configSchema">> = {
  "amazon-bedrock": {
    requiredSecrets: ["AWS_BEARER_TOKEN_BEDROCK"],
    optionalSecrets: [],
    configSchema: {
      region: { type: "string", default: "us-east-1" },
    },
  },
  anthropic: {
    requiredSecrets: ["ANTHROPIC_API_KEY"],
    optionalSecrets: ["ANTHROPIC_OAUTH_TOKEN"],
    configSchema: {},
  },
  openai: {
    requiredSecrets: ["OPENAI_API_KEY"],
    optionalSecrets: [],
    configSchema: {},
  },
  "cloudflare-workers-ai": {
    requiredSecrets: ["CLOUDFLARE_API_KEY"],
    optionalSecrets: [],
    configSchema: {
      account_id: { type: "string" },
    },
  },
  "azure-openai-responses": {
    requiredSecrets: ["AZURE_OPENAI_API_KEY"],
    optionalSecrets: [],
    configSchema: {},
  },
  deepseek: {
    requiredSecrets: ["DEEPSEEK_API_KEY"],
    optionalSecrets: [],
    configSchema: {},
  },
  google: {
    requiredSecrets: ["GEMINI_API_KEY"],
    optionalSecrets: [],
    configSchema: {},
  },
  "google-vertex": {
    requiredSecrets: ["GOOGLE_CLOUD_API_KEY"],
    optionalSecrets: [],
    configSchema: {},
  },
  groq: {
    requiredSecrets: ["GROQ_API_KEY"],
    optionalSecrets: [],
    configSchema: {},
  },
  cerebras: {
    requiredSecrets: ["CEREBRAS_API_KEY"],
    optionalSecrets: [],
    configSchema: {},
  },
  xai: {
    requiredSecrets: ["XAI_API_KEY"],
    optionalSecrets: [],
    configSchema: {},
  },
  openrouter: {
    requiredSecrets: ["OPENROUTER_API_KEY"],
    optionalSecrets: [],
    configSchema: {},
  },
  "vercel-ai-gateway": {
    requiredSecrets: ["AI_GATEWAY_API_KEY"],
    optionalSecrets: [],
    configSchema: {},
  },
  zai: {
    requiredSecrets: ["ZAI_API_KEY"],
    optionalSecrets: [],
    configSchema: {},
  },
  mistral: {
    requiredSecrets: ["MISTRAL_API_KEY"],
    optionalSecrets: [],
    configSchema: {},
  },
  minimax: {
    requiredSecrets: ["MINIMAX_API_KEY"],
    optionalSecrets: [],
    configSchema: {},
  },
  "minimax-cn": {
    requiredSecrets: ["MINIMAX_CN_API_KEY"],
    optionalSecrets: [],
    configSchema: {},
  },
  moonshotai: {
    requiredSecrets: ["MOONSHOT_API_KEY"],
    optionalSecrets: [],
    configSchema: {},
  },
  "moonshotai-cn": {
    requiredSecrets: ["MOONSHOT_API_KEY"],
    optionalSecrets: [],
    configSchema: {},
  },
  huggingface: {
    requiredSecrets: ["HF_TOKEN"],
    optionalSecrets: [],
    configSchema: {},
  },
  fireworks: {
    requiredSecrets: ["FIREWORKS_API_KEY"],
    optionalSecrets: [],
    configSchema: {},
  },
  together: {
    requiredSecrets: ["TOGETHER_API_KEY"],
    optionalSecrets: [],
    configSchema: {},
  },
  opencode: {
    requiredSecrets: ["OPENCODE_API_KEY"],
    optionalSecrets: [],
    configSchema: {},
  },
  "opencode-go": {
    requiredSecrets: ["OPENCODE_API_KEY"],
    optionalSecrets: [],
    configSchema: {},
  },
  "kimi-coding": {
    requiredSecrets: ["KIMI_API_KEY"],
    optionalSecrets: [],
    configSchema: {},
  },
  "cloudflare-ai-gateway": {
    requiredSecrets: ["CLOUDFLARE_API_KEY"],
    optionalSecrets: [],
    configSchema: {},
  },
  xiaomi: {
    requiredSecrets: ["XIAOMI_API_KEY"],
    optionalSecrets: [],
    configSchema: {},
  },
  "xiaomi-token-plan-cn": {
    requiredSecrets: ["XIAOMI_TOKEN_PLAN_CN_API_KEY"],
    optionalSecrets: [],
    configSchema: {},
  },
  "xiaomi-token-plan-ams": {
    requiredSecrets: ["XIAOMI_TOKEN_PLAN_AMS_API_KEY"],
    optionalSecrets: [],
    configSchema: {},
  },
  "xiaomi-token-plan-sgp": {
    requiredSecrets: ["XIAOMI_TOKEN_PLAN_SGP_API_KEY"],
    optionalSecrets: [],
    configSchema: {},
  },
  "github-copilot": {
    requiredSecrets: ["COPILOT_GITHUB_TOKEN"],
    optionalSecrets: [],
    configSchema: {},
  },
  "openai-codex": {
    requiredSecrets: ["OPENAI_CODEX_API_KEY"],
    optionalSecrets: [],
    configSchema: {},
  },
};

export type ModelProvider = string;

function getDefaultModel(provider: string): string | undefined {
  return getModelsForProvider(provider)[0]?.id;
}

export function getProviderDefinition(
  provider: string
): ProviderDefinition | null {
  if (!isProviderSupported(provider)) {
    return null;
  }

  const secrets = PROVIDER_SECRET_DEFINITIONS[provider] ?? {
    requiredSecrets: [],
    optionalSecrets: [],
    configSchema: {},
  };

  return {
    provider,
    ...secrets,
    defaultModel: getDefaultModel(provider),
  };
}

export function getSupportedProviders(): string[] {
  return getProviders();
}

export function isProviderSupported(provider: string): boolean {
  return getSupportedProviders().includes(provider);
}

export function requiredSecretsForProvider(provider: string): string[] {
  const def = getProviderDefinition(provider);
  return def?.requiredSecrets ?? [];
}

export function optionalSecretsForProvider(provider: string): string[] {
  const def = getProviderDefinition(provider);
  return def?.optionalSecrets ?? [];
}

export function defaultModelForProvider(provider: string): string | undefined {
  const def = getProviderDefinition(provider);
  return def?.defaultModel;
}

export function isModelSupportedForProvider(provider: string, modelId: string): boolean {
  return Boolean(getModel(provider as never, modelId as never));
}

export function getModelsForProvider(provider: string) {
  if (!isProviderSupported(provider)) {
    return [];
  }

  return getModels(provider as never);
}
