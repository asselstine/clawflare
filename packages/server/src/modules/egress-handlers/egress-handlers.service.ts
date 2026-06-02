import type { Env } from "../../internal-types/index.js";
import {
  EgressHandlerRepository,
  type EgressHandlerMetadata,
} from "../../data/index.js";
import {
  getSecretBrokerClient,
  type AuthSession,
} from "../secrets/index.js";
import {
  getEgressHandlerDefinition,
  listEgressHandlerDefinitions,
  optionalSecretsForEgressHandler,
  requiredSecretsForEgressHandler,
} from "./egress-handlers.catalog.js";

export interface PublicEgressHandler {
  egressHandlerId: string;
  name: string;
  displayName: string;
  description: string;
  domains: string[];
  enabled: boolean;
  configuredSecrets: string[];
  requiredSecrets: string[];
  optionalSecrets: string[];
  configSchema?: Record<string, unknown>;
  updatedAt: number;
}

export interface ResolvedEgressHandler {
  metadata: EgressHandlerMetadata;
  secrets: Record<string, string>;
}

function createEgressHandlerSecretRef(
  workspaceId: string,
  egressHandlerId: string,
  key: string
): string {
  return `workspaces_${workspaceId}_egress_${egressHandlerId}_${key}`;
}

export function redactEgressHandler(handler: EgressHandlerMetadata): PublicEgressHandler {
  const definition = getEgressHandlerDefinition(handler.egressHandlerId);
  return {
    egressHandlerId: handler.egressHandlerId,
    name: handler.name,
    displayName: handler.name,
    description: handler.description,
    domains: handler.domains,
    enabled: handler.enabled,
    configuredSecrets: Object.keys(handler.secretRefs),
    requiredSecrets: definition?.requiredSecrets ?? [],
    optionalSecrets: definition?.optionalSecrets ?? [],
    configSchema: definition?.configSchema,
    updatedAt: handler.updatedAt,
  };
}

export function listAvailableEgressHandlers(): PublicEgressHandler[] {
  return listEgressHandlerDefinitions().map((definition) => ({
    egressHandlerId: definition.egressHandlerId,
    name: definition.name,
    displayName: definition.name,
    description: definition.description,
    domains: definition.domains,
    enabled: false,
    configuredSecrets: [],
    requiredSecrets: definition.requiredSecrets,
    optionalSecrets: definition.optionalSecrets,
    configSchema: definition.configSchema,
    updatedAt: 0,
  }));
}

function validateSecrets(
  egressHandlerId: string,
  existingRefs: Record<string, string>,
  secrets?: Record<string, string>
): void {
  const requiredSecrets = requiredSecretsForEgressHandler(egressHandlerId);
  const allowedSecrets = new Set([
    ...requiredSecrets,
    ...optionalSecretsForEgressHandler(egressHandlerId),
  ]);

  for (const key of Object.keys(secrets ?? {})) {
    if (!allowedSecrets.has(key)) {
      throw new Error(`Unknown secret "${key}" for egress handler "${egressHandlerId}"`);
    }
  }

  const missing = requiredSecrets.filter((key) => !secrets?.[key] && !existingRefs[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required secrets: ${missing.join(", ")}`);
  }
}

export async function configureEgressHandler(
  env: Env,
  workspaceId: string,
  auth: AuthSession,
  input: {
    egressHandlerId: string;
    secrets?: Record<string, string>;
    config?: Record<string, unknown>;
    enabled?: boolean;
  }
): Promise<EgressHandlerMetadata> {
  const definition = getEgressHandlerDefinition(input.egressHandlerId);
  if (!definition) {
    throw new Error(`Unknown egress handler "${input.egressHandlerId}"`);
  }

  const repo = new EgressHandlerRepository(env.DB);
  const existing = await repo.get(workspaceId, input.egressHandlerId);
  const secretRefs = { ...(existing?.secretRefs ?? {}) };

  validateSecrets(input.egressHandlerId, secretRefs, input.secrets);

  const secretBroker = getSecretBrokerClient(env);
  for (const [key, value] of Object.entries(input.secrets ?? {})) {
    if (!value) continue;
    const ref = createEgressHandlerSecretRef(workspaceId, input.egressHandlerId, key);
    await secretBroker.put(auth, ref, value);
    secretRefs[key] = ref;
  }

  await repo.upsert({
    workspaceId,
    egressHandlerId: definition.egressHandlerId,
    name: definition.name,
    description: definition.description,
    domains: definition.domains,
    enabled: input.enabled ?? true,
    secretRefs,
    config: input.config ?? existing?.config ?? {},
  });

  const updated = await repo.get(workspaceId, input.egressHandlerId);
  if (!updated) {
    throw new Error("Failed to configure egress handler");
  }
  return updated;
}

export async function setEgressHandlerEnabled(
  env: Env,
  workspaceId: string,
  egressHandlerId: string,
  enabled: boolean
): Promise<EgressHandlerMetadata> {
  const definition = getEgressHandlerDefinition(egressHandlerId);
  if (!definition) {
    throw new Error(`Unknown egress handler "${egressHandlerId}"`);
  }

  const repo = new EgressHandlerRepository(env.DB);
  const existing = await repo.get(workspaceId, egressHandlerId);
  await repo.upsert({
    workspaceId,
    egressHandlerId,
    name: existing?.name ?? definition.name,
    description: existing?.description ?? definition.description,
    domains: existing?.domains ?? definition.domains,
    enabled,
    secretRefs: existing?.secretRefs ?? {},
    config: existing?.config ?? {},
  });

  const updated = await repo.get(workspaceId, egressHandlerId);
  if (!updated) {
    throw new Error("Failed to update egress handler");
  }
  return updated;
}

export async function deleteEgressHandler(
  env: Env,
  workspaceId: string,
  egressHandlerId: string,
  auth: AuthSession
): Promise<void> {
  const repo = new EgressHandlerRepository(env.DB);
  const existing = await repo.getConfigured(workspaceId, egressHandlerId);
  if (!existing) {
    throw new Error("Egress handler not found");
  }

  const secretBroker = getSecretBrokerClient(env);
  const deleteErrors: string[] = [];
  for (const ref of Object.values(existing.secretRefs)) {
    try {
      await secretBroker.delete(auth, ref);
    } catch (error) {
      deleteErrors.push(error instanceof Error ? error.message : String(error));
    }
  }

  await repo.delete(workspaceId, egressHandlerId);

  if (deleteErrors.length > 0) {
    console.warn("[deleteEgressHandler] Failed to delete some secrets:", deleteErrors);
  }
}

export async function resolveEgressHandler(
  env: Env,
  auth: AuthSession | undefined,
  handler: EgressHandlerMetadata
): Promise<ResolvedEgressHandler> {
  const secrets: Record<string, string> = {};
  if (auth) {
    const secretBroker = getSecretBrokerClient(env);
    for (const [key, ref] of Object.entries(handler.secretRefs)) {
      const value = await secretBroker.get(auth, ref);
      if (value) {
        secrets[key] = value;
      }
    }
  }

  return { metadata: handler, secrets };
}
