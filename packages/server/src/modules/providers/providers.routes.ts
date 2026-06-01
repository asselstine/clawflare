import { Hono } from "hono";
import type { AppBindings } from "../../http/app-bindings.js";
import { requireAuth } from "../../middleware/auth.js";
import { badRequest, json, notFound } from "../../http/responses.js";
import {
  getModelsForProvider,
  getSupportedProviders,
  isProviderSupported,
  optionalSecretsForProvider,
  requiredSecretsForProvider,
} from "./providers.catalog.js";

export const providersRoutes = new Hono<AppBindings>();

providersRoutes.use("*", requireAuth);
providersRoutes.get("/", () => handleListProviders());
providersRoutes.get("/:id/models", (c) => handleListProviderModels(c.req.param("id")));

// AI Providers HTTP Routes
// Returns supported AI providers with their required secrets

/**
 * Provider info for API response
 */
export interface ProviderInfo {
  id: string;
  name: string;
  requiredSecrets: string[];
  optionalSecrets: string[];
}

export interface ProviderModelInfo {
  id: string;
  name: string;
  api: string;
  provider: string;
  input: string[];
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
}

/**
 * Get supported AI providers with their required secrets
 */
export async function handleListProviders(): Promise<Response> {
  try {
    const providerIds = getSupportedProviders();

    const providers: ProviderInfo[] = providerIds.map((id) => {
      return {
        id,
        name: id,
        requiredSecrets: requiredSecretsForProvider(id),
        optionalSecrets: optionalSecretsForProvider(id),
      };
    });

    return json({ providers });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return json({ error: message }, { status: 500 });
  }
}

/**
 * Get supported models for a provider.
 */
export async function handleListProviderModels(providerId: string): Promise<Response> {
  if (!providerId) {
    return badRequest("provider id is required");
  }

  if (!isProviderSupported(providerId)) {
    return notFound(`Provider "${providerId}"`);
  }

  const models: ProviderModelInfo[] = getModelsForProvider(providerId).map((model) => ({
    id: model.id,
    name: model.name,
    api: model.api,
    provider: model.provider,
    input: [...model.input],
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    reasoning: Boolean(model.reasoning),
  }));

  return json({ provider: providerId, models });
}
