import { Hono } from "hono";
import type { AppBindings } from "../../http/app-bindings.js";
import { requireAuth } from "../../middleware/auth.js";
import { badRequest, json, notFound } from "../../http/responses.js";
import type { RequestContext } from "../../http/request-context.js";
import type { Env } from "../../internal-types/index.js";
import { logger } from "../../lib/logger.js";
import { logTiming, timingStart } from "../../lib/timing.js";
import type { AuthSession } from "../secrets/index.js";
import { createProvider, deleteProvider, listProviders as listWorkspaceProviders } from "../models/models.service.js";
import { redactModel, redactProvider, type PublicModel, type PublicProvider } from "../models/models.validation.js";
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
providersRoutes.delete("/:id", (c) => handleDeleteProvider(c.env, c.get("requestContext")!, c.req.param("id")));

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
  model?: PublicModel;
  defaultModelId?: string;
}

interface DeleteProviderResponse {
  ok: boolean;
  providerId: string;
  deletedModelIds: string[];
  clearedDefaultModelId?: string;
}

interface CreateProviderRequest {
  provider: string;
  providerDisplayName?: string;
  secrets?: Record<string, string>;
  config?: Record<string, unknown>;
  defaultModelName?: string;
  createDefaultModel?: boolean;
  modelDisplayName?: string;
  modelConfig?: Record<string, unknown>;
  setAsDefault?: boolean;
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
  const routeStart = timingStart();
  try {
    const listStart = timingStart();
    const providers = await listWorkspaceProviders(env, requestContext.workspace.id);
    logTiming(env, undefined, "providers.configured.db_list", listStart, {
      workspaceId: requestContext.workspace.id,
      providerCount: providers.length,
    });

    const responseBody = { providers: providers.map(redactProvider) } satisfies ConfiguredProviderListResponse;
    const response = json(responseBody);
    response.headers.append("Server-Timing", `providers-db;dur=${Date.now() - listStart}`);
    response.headers.append("Server-Timing", `providers-total;dur=${Date.now() - routeStart}`);
    logTiming(env, undefined, "providers.configured.response", routeStart, {
      workspaceId: requestContext.workspace.id,
      providerCount: providers.length,
    });
    return response;
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
      defaultModelName: body.defaultModelName,
      createDefaultModel: body.createDefaultModel,
      modelDisplayName: body.modelDisplayName,
      modelConfig: body.modelConfig,
      setAsDefault: body.setAsDefault,
    });

    return json({
      provider: redactProvider(result.provider),
      model: result.model ? redactModel(result.model) : undefined,
      defaultModelId: result.model && body.setAsDefault ? result.model.id : undefined,
    } satisfies ConfiguredProviderResponse, { status: 201 });
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

export async function handleDeleteProvider(
  env: Env,
  requestContext: RequestContext,
  id: string
): Promise<Response> {
  try {
    const result = await deleteProvider(env, requestContext.workspace.id, id);
    return json({
      ok: true,
      providerId: result.providerId,
      deletedModelIds: result.deletedModelIds,
      clearedDefaultModelId: result.clearedDefaultModelId,
    } satisfies DeleteProviderResponse);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("not found")) return notFound("Provider");
    if (message.includes("active session")) return badRequest(message);
    logger.error("Configured provider deletion failed", error, {
      handler: "handleDeleteProvider",
      route: "DELETE /v1/providers/:id",
      id,
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
