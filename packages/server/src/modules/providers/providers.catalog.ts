import * as z from "zod";

export interface ProviderDefinition {
  provider: string;
  requiredSecrets: string[];
  optionalSecrets: string[];
  configSchema: Record<string, z.ZodTypeAny>;
  defaultModel?: string;
}

const PROVIDER_DEFINITIONS = {
  "amazon-bedrock": {
    provider: "amazon-bedrock",
    requiredSecrets: ["AWS_BEARER_TOKEN_BEDROCK"],
    optionalSecrets: [],
    configSchema: {
      region: z.string().optional().default("us-east-1"),
    },
    defaultModel: "minimax.minimax-m2.5",
  },
  anthropic: {
    provider: "anthropic",
    requiredSecrets: ["ANTHROPIC_API_KEY"],
    optionalSecrets: [],
    configSchema: {},
    defaultModel: "claude-3-opus-20240229",
  },
  openai: {
    provider: "openai",
    requiredSecrets: ["OPENAI_API_KEY"],
    optionalSecrets: [],
    configSchema: {},
    defaultModel: "gpt-4",
  },
  "cloudflare-workers-ai": {
    provider: "cloudflare-workers-ai",
    requiredSecrets: [],
    optionalSecrets: [],
    configSchema: {
      account_id: z.string().optional(),
    },
    defaultModel: "@cf/meta/llama-2-7b-chat-int8",
  },
} satisfies Record<string, ProviderDefinition>;

export type ModelProvider = keyof typeof PROVIDER_DEFINITIONS;

export function getProviderDefinition(
  provider: string
): ProviderDefinition | null {
  return PROVIDER_DEFINITIONS[provider as ModelProvider] ?? null;
}

export function getSupportedProviders(): string[] {
  return Object.keys(PROVIDER_DEFINITIONS);
}

export function isProviderSupported(provider: string): boolean {
  return provider in PROVIDER_DEFINITIONS;
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
