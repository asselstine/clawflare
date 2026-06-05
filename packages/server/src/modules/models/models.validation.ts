import * as z from "zod";
import type { Model, Provider } from "../../data/index.js";
import {
  getProviderDefinition,
  getSupportedProviders,
  isModelSupportedForProvider,
} from "../providers/providers.catalog.js";

export interface ModelInput {
  provider: string;
  modelName: string;
  secrets: Record<string, string>;
  config?: Record<string, unknown>;
}

export interface ParsedModel {
  provider: string;
  modelName: string;
  requiredSecrets: string[];
  missingSecrets: string[];
  configuredSecrets: string[];
  config: Record<string, unknown>;
}

export interface PublicModel {
  id: string;
  workspaceId: string;
  providerId: string;
  displayName?: string;
  provider: string;
  providerDisplayName?: string;
  modelName: string;
  configuredSecrets: string[];
  requiredSecrets: string[];
  createdAt: number;
  updatedAt: number;
}

export interface PublicProvider {
  id: string;
  workspaceId: string;
  provider: string;
  providerDisplayName?: string;
  configuredSecrets: string[];
  requiredSecrets: string[];
  createdAt: number;
  updatedAt: number;
}

export function validateModelInput(input: unknown): { ok: true; result: ParsedModel } | { ok: false; error: string } {
  const schema = z.object({
    provider: z.string().min(1),
    modelName: z.string().min(1),
    secrets: z.record(z.string(), z.string()).default({}),
    config: z.record(z.string(), z.unknown()).optional(),
  });

  const parsed = schema.safeParse(input);
  if (!parsed.success) return { ok: false, error: `Invalid input: ${parsed.error.message}` };

  const data = parsed.data;
  const providerDef = getProviderDefinition(data.provider);
  if (!providerDef) {
    const supported = getSupportedProviders().join(", ");
    return { ok: false, error: `Unknown provider "${data.provider}". Supported providers: ${supported}` };
  }

  if (!isModelSupportedForProvider(data.provider, data.modelName)) {
    return { ok: false, error: `Unknown model "${data.modelName}" for provider "${data.provider}"` };
  }

  const missingSecrets = providerDef.requiredSecrets.filter((key) => !(key in data.secrets) || !data.secrets[key]);
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

export function redactModel(model: Model): PublicModel {
  const providerDef = getProviderDefinition(model.provider);
  const requiredSecrets = providerDef?.requiredSecrets ?? [];
  const optionalSecrets = providerDef?.optionalSecrets ?? [];
  const allProviderSecrets = [...requiredSecrets, ...optionalSecrets];
  const configuredSecrets = Object.keys(model.secretRefs).filter((key) => allProviderSecrets.includes(key));

  return {
    id: model.id,
    workspaceId: model.workspaceId,
    providerId: model.providerId,
    displayName: model.displayName,
    provider: model.provider,
    providerDisplayName: model.providerDisplayName,
    modelName: model.modelName,
    configuredSecrets,
    requiredSecrets,
    createdAt: model.createdAt,
    updatedAt: model.updatedAt,
  };
}

export function redactModels(models: Model[]): PublicModel[] {
  return models.map(redactModel);
}

export function redactProvider(provider: Provider): PublicProvider {
  const providerDef = getProviderDefinition(provider.provider);
  const requiredSecrets = providerDef?.requiredSecrets ?? [];
  const optionalSecrets = providerDef?.optionalSecrets ?? [];
  const knownSecrets = [...requiredSecrets, ...optionalSecrets];
  const configuredSecrets = Object.keys(provider.secretRefs).filter((key) => knownSecrets.includes(key));

  return {
    id: provider.id,
    workspaceId: provider.workspaceId,
    provider: provider.provider,
    providerDisplayName: provider.displayName,
    configuredSecrets,
    requiredSecrets,
    createdAt: provider.createdAt,
    updatedAt: provider.updatedAt,
  };
}
