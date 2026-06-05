// Model service
// Coordinates D1 persistence and Secret Store for AI providers and models.

import type { Env } from "../../internal-types/index.js";
import { ModelRepository, ProviderRepository, SessionRepository, type Model, type Provider } from "../../data/index.js";
import { getSecretBrokerClient, type AuthSession } from "../secrets/index.js";
import {
  defaultModelForProvider,
  getSupportedProviders,
  isProviderSupported,
  isModelSupportedForProvider,
  requiredSecretsForProvider,
} from "../providers/providers.catalog.js";
import { shouldUseMockAI } from "../../runtime/mock-ai.js";
import { redactModel, validateModelInput, type PublicModel } from "./models.validation.js";

export interface ResolvedModel {
  id: string;
  providerId?: string;
  provider: string;
  modelName: string;
  secrets: Record<string, string>;
  config: Record<string, unknown>;
  providerConfig?: Record<string, unknown>;
}

export interface CreateModelResult {
  model: Model;
  secretsStored: string[];
}

export interface CreateProviderResult {
  provider: Provider;
  secretsStored: string[];
}

function createProviderSecretRef(workspaceId: string, providerId: string, key: string): string {
  return `workspaces_${workspaceId}_provider_${providerId}_${key}`;
}

export async function createProvider(
  env: Env,
  workspaceId: string,
  auth: AuthSession,
  input: {
    provider: string;
    providerDisplayName?: string;
    secrets?: Record<string, string>;
    config?: Record<string, unknown>;
  }
): Promise<CreateProviderResult> {
  if (!isProviderSupported(input.provider)) {
    const supported = getSupportedProviders().join(", ");
    throw new Error(`Unknown provider "${input.provider}". Supported providers: ${supported}`);
  }

  const requiredSecrets = requiredSecretsForProvider(input.provider);
  const missingSecrets = requiredSecrets.filter((key) => !(key in (input.secrets ?? {})) || !input.secrets?.[key]);
  if (missingSecrets.length > 0 && !shouldUseMockAI(env)) {
    throw new Error(`Missing required secrets: ${missingSecrets.join(", ")}`);
  }

  const providers = new ProviderRepository(env.DB);
  const secretBroker = getSecretBrokerClient(env);
  let provider = await providers.create({
    workspaceId,
    displayName: input.providerDisplayName,
    provider: input.provider,
    config: input.config,
  });

  const secretRefs = { ...provider.secretRefs };
  const secretsStored: string[] = [];
  for (const [key, value] of Object.entries(input.secrets ?? {})) {
    if (!value) continue;
    const ref = createProviderSecretRef(workspaceId, provider.id, key);
    await secretBroker.put(auth, ref, value);
    secretRefs[key] = ref;
    secretsStored.push(key);
  }

  if (secretsStored.length > 0) {
    provider = await providers.update(workspaceId, provider.id, { secretRefs });
  }

  return { provider, secretsStored };
}

export async function listProviders(env: Env, workspaceId: string): Promise<Provider[]> {
  return new ProviderRepository(env.DB).list(workspaceId);
}

export async function createModel(
  env: Env,
  workspaceId: string,
  auth: AuthSession,
  input: {
    displayName?: string;
    provider: string;
    providerDisplayName?: string;
    providerId?: string;
    modelName: string;
    secrets?: Record<string, string>;
    config?: Record<string, unknown>;
    providerConfig?: Record<string, unknown>;
    setAsDefault?: boolean;
  }
): Promise<CreateModelResult> {
  const validation = validateModelInput({
    provider: input.provider,
    modelName: input.modelName,
    secrets: input.secrets ?? {},
    config: input.config,
  });

  if (!validation.ok) throw new Error(validation.error);
  if (validation.result.missingSecrets.length > 0 && !input.providerId) {
    throw new Error(`Missing required secrets: ${validation.result.missingSecrets.join(", ")}`);
  }

  const providers = new ProviderRepository(env.DB);
  const models = new ModelRepository(env.DB);
  const secretBroker = getSecretBrokerClient(env);

  let provider = input.providerId ? await providers.get(workspaceId, input.providerId) : null;
  if (input.providerId && !provider) {
    throw new Error("Provider not found");
  }

  if (provider && provider.provider !== input.provider) {
    throw new Error(`Provider "${provider.id}" is configured for "${provider.provider}", not "${input.provider}"`);
  }

  if (!provider) {
    provider = await providers.create({
      workspaceId,
      displayName: input.providerDisplayName,
      provider: input.provider,
      config: input.providerConfig,
    });
  }

  const secretRefs = { ...provider.secretRefs };
  const secretsStored: string[] = [];
  for (const [key, value] of Object.entries(input.secrets ?? {})) {
    if (!value) continue;
    const ref = createProviderSecretRef(workspaceId, provider.id, key);
    await secretBroker.put(auth, ref, value);
    secretRefs[key] = ref;
    secretsStored.push(key);
  }

  if (secretsStored.length > 0) {
    provider = await providers.update(workspaceId, provider.id, { secretRefs });
  }

  for (const key of requiredSecretsForProvider(provider.provider)) {
    if (!provider.secretRefs[key] && !shouldUseMockAI(env)) {
      throw new Error(`Missing required secret: ${key}`);
    }
  }

  const model = await models.create({
    workspaceId,
    providerId: provider.id,
    displayName: input.displayName,
    modelName: input.modelName,
    config: input.config,
  });

  if (input.setAsDefault) {
    await models.setWorkspaceDefault(workspaceId, model.id);
  }

  return { model, secretsStored };
}

export async function updateModel(
  env: Env,
  workspaceId: string,
  id: string,
  auth: AuthSession,
  input: {
    displayName?: string | null;
    modelName?: string;
    secrets?: Record<string, string>;
    config?: Record<string, unknown>;
    providerConfig?: Record<string, unknown>;
  }
): Promise<Model> {
  const providers = new ProviderRepository(env.DB);
  const models = new ModelRepository(env.DB);
  const secretBroker = getSecretBrokerClient(env);

  const existing = await models.get(workspaceId, id);
  if (!existing) throw new Error("Model not found");

  let modelName = input.modelName ?? existing.modelName;
  if (!modelName) {
    const defaultModel = defaultModelForProvider(existing.provider);
    if (defaultModel) modelName = defaultModel;
  }

  if (!isModelSupportedForProvider(existing.provider, modelName)) {
    throw new Error(`Unknown model "${modelName}" for provider "${existing.provider}"`);
  }

  let secretRefs = { ...existing.secretRefs };
  if (input.secrets && Object.keys(input.secrets).length > 0) {
    for (const key of requiredSecretsForProvider(existing.provider)) {
      if (!(key in input.secrets) && !secretRefs[key]) {
        throw new Error(`Missing required secret: ${key}`);
      }
    }

    for (const [key, value] of Object.entries(input.secrets)) {
      if (!value) continue;
      const ref = createProviderSecretRef(workspaceId, existing.providerId, key);
      await secretBroker.put(auth, ref, value);
      secretRefs[key] = ref;
    }

    await providers.update(workspaceId, existing.providerId, { secretRefs });
  }

  if (input.providerConfig !== undefined) {
    await providers.update(workspaceId, existing.providerId, { config: input.providerConfig });
  }

  return models.update(workspaceId, id, {
    displayName: input.displayName,
    modelName,
    config: input.config,
  });
}

export async function deleteModel(env: Env, workspaceId: string, id: string): Promise<void> {
  const models = new ModelRepository(env.DB);
  try {
    await models.softDelete(workspaceId, id);
  } catch (error) {
    throw new Error(`Failed to delete model: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function resolveModel(
  env: Env,
  workspaceId: string,
  modelId: string,
  auth: AuthSession
): Promise<ResolvedModel> {
  const models = new ModelRepository(env.DB);
  const secretBroker = getSecretBrokerClient(env);
  const model = await models.get(workspaceId, modelId);

  if (!model) throw new Error("Model not found");

  const secrets: Record<string, string> = {};
  for (const key of requiredSecretsForProvider(model.provider)) {
    if (shouldUseMockAI(env)) {
      secrets[key] = "mock-secret";
      continue;
    }

    const ref = model.secretRefs[key];
    if (!ref) throw new Error(`Model "${model.id}" provider is missing required secret reference "${key}"`);

    const value = await secretBroker.get(auth, ref);
    if (!value) throw new Error(`Model "${model.id}" provider is missing required secret "${key}"`);
    secrets[key] = value;
  }

  return {
    id: model.id,
    providerId: model.providerId,
    provider: model.provider,
    modelName: model.modelName,
    secrets,
    config: model.config,
    providerConfig: model.providerConfig,
  };
}

export async function resolveModelForNewSession(
  env: Env,
  workspaceId: string,
  requestedId: string | undefined,
  auth: AuthSession
): Promise<ResolvedModel | null> {
  const models = new ModelRepository(env.DB);

  if (requestedId) {
    const model = await models.get(workspaceId, requestedId);
    if (!model) return null;
    return resolveModel(env, workspaceId, requestedId, auth);
  }

  const defaultModel = await models.getWorkspaceDefault(workspaceId);
  return defaultModel ? resolveModel(env, workspaceId, defaultModel.id, auth) : null;
}

export async function resolveModelForSession(
  env: Env,
  sessionId: string,
  auth: AuthSession
): Promise<ResolvedModel | null> {
  const sessions = new SessionRepository(env.DB);
  const models = new ModelRepository(env.DB);

  const session = await sessions.findById(sessionId);
  if (!session) throw new Error("Session not found");

  if (session.modelId) {
    return resolveModel(env, session.workspaceId, session.modelId, auth);
  }

  const defaultModel = await models.getWorkspaceDefault(session.workspaceId);
  return defaultModel ? resolveModel(env, session.workspaceId, defaultModel.id, auth) : null;
}

export async function setWorkspaceDefaultModel(env: Env, workspaceId: string, id: string | null): Promise<void> {
  const models = new ModelRepository(env.DB);
  await models.setWorkspaceDefault(workspaceId, id);
}

export async function hasModels(env: Env, workspaceId: string): Promise<boolean> {
  const models = new ModelRepository(env.DB);
  const list = await models.list(workspaceId);
  return list.length > 0;
}

export async function getWorkspaceDefaultModel(env: Env, workspaceId: string): Promise<PublicModel | null> {
  const models = new ModelRepository(env.DB);
  const model = await models.getWorkspaceDefault(workspaceId);
  return model ? redactModel(model) : null;
}

export async function listModels(env: Env, workspaceId: string): Promise<PublicModel[]> {
  const models = new ModelRepository(env.DB);
  const list = await models.list(workspaceId);
  return list.map(redactModel);
}
