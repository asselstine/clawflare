import * as z from "zod";
import type { ModelConnection } from "../../data/index.js";
import {
  getProviderDefinition,
  getSupportedProviders,
} from "../providers/providers.catalog.js";

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
    (key) =>
      data.secrets[key] &&
      (providerDef.requiredSecrets.includes(key) ||
        providerDef.optionalSecrets.includes(key))
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

export function redactModelConnection(
  connection: ModelConnection
): PublicModelConnection {
  const providerDef = getProviderDefinition(connection.provider);
  const requiredSecrets = providerDef?.requiredSecrets ?? [];
  const optionalSecrets = providerDef?.optionalSecrets ?? [];
  const allProviderSecrets = [...requiredSecrets, ...optionalSecrets];

  const configuredSecrets = Object.keys(connection.secretRefs).filter((key) =>
    allProviderSecrets.includes(key)
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

export function redactModelConnections(
  connections: ModelConnection[]
): PublicModelConnection[] {
  return connections.map(redactModelConnection);
}
