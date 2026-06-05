import { Hono } from "hono";
import type { AppBindings } from "../../http/app-bindings.js";
import { requireAuth } from "../../middleware/auth.js";
import { badRequest, json, notFound } from "../../http/responses.js";
import type { RequestContext } from "../../http/request-context.js";
import type { Env } from "../../internal-types/index.js";
import { logger } from "../../lib/logger.js";
import type { AuthSession } from "../secrets/index.js";
import { createProvider, listProviders as listWorkspaceProviders } from "../models/models.service.js";
import { redactProvider, type PublicProvider } from "../models/models.validation.js";
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
providersRoutes.post("/", (c) => handleCreateProvider(c.req.raw, c.env, c.get("requestContext")!));
providersRoutes.get("/configured", (c) => handleListConfiguredProviders(c.env, c.get("requestContext")!));
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

interface ConfiguredProviderListResponse {
  providers: PublicProvider[];
}

interface ConfiguredProviderResponse {
  provider: PublicProvider;
}

interface CreateProviderRequest {
  provider: string;
  providerDisplayName?: string;
  secrets?: Record<string, string>;
  config?: Record<string, unknown>;
}

function createAuthSession(ctx: RequestContext): AuthSession {
  return {
    type: "immediate",
    context: {
      userId: ctx.user.id,
      workspaceId: ctx.workspace.id,
      authTime: Date.now(),
      requestId: crypto.randomUUID(),
      version: 1,
    },
  };
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

export async function handleListConfiguredProviders(env: Env, requestContext: RequestContext): Promise<Response> {
  try {
    const providers = await listWorkspaceProviders(env, requestContext.workspace.id);
    return json({ providers: providers.map(redactProvider) } satisfies ConfiguredProviderListResponse);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("Configured provider list failed", error, {
      handler: "handleListConfiguredProviders",
      route: "GET /v1/providers/configured",
      workspaceId: requestContext.workspace.id,
    });
    return json({ error: message }, { status: 500 });
  }
}

export async function handleCreateProvider(
  request: Request,
  env: Env,
  requestContext: RequestContext
): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as CreateProviderRequest;

  if (!body.provider || typeof body.provider !== "string") return badRequest("provider is required");
  if (body.secrets !== undefined && typeof body.secrets !== "object") return badRequest("secrets must be an object");

  const auth = createAuthSession(requestContext);
  try {
    const result = await createProvider(env, requestContext.workspace.id, auth, {
      provider: body.provider,
      providerDisplayName: body.providerDisplayName,
      secrets: body.secrets ?? {},
      config: body.config,
    });

    return json({ provider: redactProvider(result.provider) } satisfies ConfiguredProviderResponse, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("Configured provider creation failed", error, {
      handler: "handleCreateProvider",
      route: "POST /v1/providers",
      workspaceId: requestContext.workspace.id,
    });
    return badRequest(message);
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
