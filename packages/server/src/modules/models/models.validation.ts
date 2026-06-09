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
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, error: "Invalid input: expected object" };
  }

  const raw = input as Record<string, unknown>;
  if (typeof raw.provider !== "string" || raw.provider.length === 0) {
    return { ok: false, error: "Invalid input: provider is required" };
  }
  if (typeof raw.modelName !== "string" || raw.modelName.length === 0) {
    return { ok: false, error: "Invalid input: modelName is required" };
  }
  if (raw.secrets !== undefined && (typeof raw.secrets !== "object" || raw.secrets === null || Array.isArray(raw.secrets))) {
    return { ok: false, error: "Invalid input: secrets must be an object" };
  }
  if (raw.config !== undefined && (typeof raw.config !== "object" || raw.config === null || Array.isArray(raw.config))) {
    return { ok: false, error: "Invalid input: config must be an object" };
  }

  const secrets = Object.fromEntries(Object.entries(raw.secrets ?? {}).filter((entry): entry is [string, string] => (
    typeof entry[1] === "string"
  )));
  const config = raw.config === undefined ? {} : raw.config as Record<string, unknown>;
  const data = {
    provider: raw.provider,
    modelName: raw.modelName,
    secrets,
    config,
  };
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
