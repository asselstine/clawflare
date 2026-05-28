// Model provider definitions and validation
// Supports multiple AI providers with schema-based configuration

import * as z from "zod";

// =============================================================================
// Provider Schemas
// =============================================================================

const ProviderDefinitionSchema = z.object({
  provider: z.string(),
  requiredSecrets: z.array(z.string()),
  optionalSecrets: z.array(z.string()).default([]),
  configSchema: z.record(z.string(), z.any()),
  defaultModel: z.string().optional(),
});

type ProviderDefinition = z.infer<typeof ProviderDefinitionSchema>;

// =============================================================================
// Provider Definitions
// =============================================================================

const PROVIDER_DEFINITIONS: Record<string, ProviderDefinition> = {
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
};

// =============================================================================
// Provider Types
// =============================================================================

export type ModelProvider = keyof typeof PROVIDER_DEFINITIONS;

export interface ModelConnectionInput {
  provider: string;
  modelName: string;
  secrets: Record<string, string>;
  config?: Record<string, unknown>;
}

export interface ParsedModelConnection {
  provider: string;
  modelName: string;
  requiredSecrets: string[];
  missingSecrets: string[];
  configuredSecrets: string[];
  config: Record<string, unknown>;
}

export interface PublicModelConnection {
  id: string;
  workspaceId: string;
  displayName?: string;
  provider: string;
  modelName: string;
  configuredSecrets: string[];
  requiredSecrets: string[];
  createdAt: number;
  updatedAt: number;
}

// =============================================================================
// Validation Functions
// =============================================================================

/**
 * Get provider definition by name
 */
export function getProviderDefinition(provider: string): ProviderDefinition | null {
  return PROVIDER_DEFINITIONS[provider] ?? null;
}

/**
 * Get list of supported providers
 */
export function getSupportedProviders(): string[] {
  return Object.keys(PROVIDER_DEFINITIONS);
}

/**
 * Check if a provider is supported
 */
export function isProviderSupported(provider: string): boolean {
  return provider in PROVIDER_DEFINITIONS;
}

/**
 * Validate model connection input
 * Returns validation result without secrets
 */
export function validateModelConnectionInput(
  input: unknown
): { ok: true; result: ParsedModelConnection } | { ok: false; error: string } {
  const schema = z.object({
    provider: z.string().min(1),
    modelName: z.string().min(1),
    secrets: z.record(z.string(), z.string()).default({}),
    config: z.record(z.string(), z.unknown()).optional(),
  });

  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: `Invalid input: ${parsed.error.message}` };
  }

  const data = parsed.data;
  const providerDef = getProviderDefinition(data.provider);

  if (!providerDef) {
    const supported = getSupportedProviders().join(", ");
    return {
      ok: false,
      error: `Unknown provider "${data.provider}". Supported providers: ${supported}`,
    };
  }

  const missingSecrets = providerDef.requiredSecrets.filter(
    (key) => !(key in data.secrets) || !data.secrets[key]
  );

  const configuredSecrets = Object.keys(data.secrets).filter(
    (key) => data.secrets[key] && (providerDef.requiredSecrets.includes(key) || providerDef.optionalSecrets.includes(key))
  );

  return {
    ok: true,
    result: {
      provider: data.provider,
      modelName: data.modelName,
      requiredSecrets: providerDef.requiredSecrets,
      missingSecrets,
      configuredSecrets,
      config: data.config ?? {},
    },
  };
}

/**
 * Get required secrets for a provider
 */
export function requiredSecretsForProvider(provider: string): string[] {
  const def = getProviderDefinition(provider);
  return def?.requiredSecrets ?? [];
}

/**
 * Get optional secrets for a provider
 */
export function optionalSecretsForProvider(provider: string): string[] {
  const def = getProviderDefinition(provider);
  return def?.optionalSecrets ?? [];
}

/**
 * Get default model for a provider
 */
export function defaultModelForProvider(provider: string): string | undefined {
  const def = getProviderDefinition(provider);
  return def?.defaultModel;
}

/**
 * Redact a model connection for public API response
 * Never includes secret values or refs
 */
export function redactModelConnection(
  connection: import("./data/interfaces.js").ModelConnection
): PublicModelConnection {
  const providerDef = getProviderDefinition(connection.provider);
  const requiredSecrets = providerDef?.requiredSecrets ?? [];
  const optionalSecrets = providerDef?.optionalSecrets ?? [];
  const allProviderSecrets = [...requiredSecrets, ...optionalSecrets];

  // Only show which secrets are configured (by key name), not the values
  const configuredSecrets = Object.keys(connection.secretRefs).filter(
    (key) => allProviderSecrets.includes(key)
  );

  return {
    id: connection.id,
    workspaceId: connection.workspaceId,
    displayName: connection.displayName,
    provider: connection.provider,
    modelName: connection.modelName,
    configuredSecrets,
    requiredSecrets,
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
  };
}

/**
 * Redact multiple model connections
 */
export function redactModelConnections(
  connections: import("./data/interfaces.js").ModelConnection[]
): PublicModelConnection[] {
  return connections.map(redactModelConnection);
}
