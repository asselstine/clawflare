import { Hono } from "hono";
import type { AppBindings } from "../../http/app-bindings.js";
import { badRequest, json, notFound } from "../../http/responses.js";
import type { RequestContext } from "../../http/request-context.js";
import type { Env } from "../../internal-types/index.js";
import { logger } from "../../lib/logger.js";
import { requireAuth } from "../../middleware/auth.js";
import type { AuthSession } from "../secrets/index.js";
import { redactModel, type PublicModel } from "./models.validation.js";
import {
  createModel,
  deleteModel,
  getWorkspaceDefaultModel,
  listModels,
  resolveModel,
  setWorkspaceDefaultModel,
  updateModel,
} from "./models.service.js";

export const modelsRoutes = new Hono<AppBindings>();
export const workspaceRoutes = new Hono<AppBindings>();

modelsRoutes.use("*", requireAuth);
modelsRoutes.get("/", (c) => handleListModels(c.req.raw, c.env, c.get("requestContext")!));
modelsRoutes.post("/", (c) => handleCreateModel(c.req.raw, c.env, c.get("requestContext")!));
modelsRoutes.get("/:id", (c) => handleGetModel(c.req.raw, c.env, c.get("requestContext")!, c.req.param("id")));
modelsRoutes.patch("/:id", (c) => handleUpdateModel(c.req.raw, c.env, c.get("requestContext")!, c.req.param("id")));
modelsRoutes.delete("/:id", (c) => handleDeleteModel(c.req.raw, c.env, c.get("requestContext")!, c.req.param("id")));

workspaceRoutes.use("*", requireAuth);
workspaceRoutes.get("/", (c) => handleGetWorkspace(c.get("requestContext")!));
workspaceRoutes.put("/default-model", (c) => handleSetDefaultModel(c.req.raw, c.env, c.get("requestContext")!));

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

interface ModelListResponse {
  models: PublicModel[];
  defaultModelId?: string;
}

interface ModelResponse {
  model: PublicModel;
}

export async function handleListModels(
  _request: Request,
  env: Env,
  requestContext: RequestContext
): Promise<Response> {
  const workspaceId = requestContext.workspace.id;
  const [models, defaultModel] = await Promise.all([
    listModels(env, workspaceId),
    getWorkspaceDefaultModel(env, workspaceId),
  ]);

  const response: ModelListResponse = {
    models,
    defaultModelId: defaultModel?.id,
  };
  return json(response);
}

interface CreateModelRequest {
  displayName?: string;
  provider: string;
  providerId?: string;
  providerDisplayName?: string;
  modelName: string;
  secrets?: Record<string, string>;
  config?: Record<string, unknown>;
  providerConfig?: Record<string, unknown>;
  setAsDefault?: boolean;
}

export async function handleCreateModel(
  request: Request,
  env: Env,
  requestContext: RequestContext
): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as CreateModelRequest;

  if (!body.provider || typeof body.provider !== "string") return badRequest("provider is required");
  if (!body.modelName || typeof body.modelName !== "string") return badRequest("modelName is required");
  if (body.secrets !== undefined && typeof body.secrets !== "object") return badRequest("secrets must be an object");

  const auth = createAuthSession(requestContext);
  try {
    const result = await createModel(env, requestContext.workspace.id, auth, {
      displayName: body.displayName,
      provider: body.provider,
      providerDisplayName: body.providerDisplayName,
      providerId: body.providerId,
      modelName: body.modelName,
      secrets: body.secrets ?? {},
      config: body.config,
      providerConfig: body.providerConfig,
      setAsDefault: body.setAsDefault,
    });

    const response: ModelResponse = {
      model: redactModel(result.model),
    };
    return json(response, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("Model creation failed", error, {
      handler: "handleCreateModel",
      route: "POST /v1/models",
      workspaceId: requestContext.workspace.id,
    });
    return badRequest(message);
  }
}

export async function handleGetModel(
  _request: Request,
  env: Env,
  requestContext: RequestContext,
  id: string
): Promise<Response> {
  const auth = createAuthSession(requestContext);

  try {
    const model = await resolveModel(env, requestContext.workspace.id, id, auth);
    return json({
      id: model.id,
      providerId: model.providerId,
      provider: model.provider,
      modelName: model.modelName,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("not found")) return notFound("Model");
    logger.error("Model get failed", error, {
      handler: "handleGetModel",
      route: "GET /v1/models/:id",
      id,
      workspaceId: requestContext.workspace.id,
    });
    return badRequest(message);
  }
}

interface UpdateModelRequest {
  displayName?: string | null;
  modelName?: string;
  secrets?: Record<string, string>;
  config?: Record<string, unknown>;
  providerConfig?: Record<string, unknown>;
}

export async function handleUpdateModel(
  request: Request,
  env: Env,
  requestContext: RequestContext,
  id: string
): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as UpdateModelRequest;
  const auth = createAuthSession(requestContext);

  try {
    const result = await updateModel(env, requestContext.workspace.id, id, auth, {
      displayName: body.displayName,
      modelName: body.modelName,
      secrets: body.secrets,
      config: body.config,
      providerConfig: body.providerConfig,
    });

    return json({ model: redactModel(result) } satisfies ModelResponse);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("not found")) return notFound("Model");
    logger.error("Model update failed", error, {
      handler: "handleUpdateModel",
      route: "PATCH /v1/models/:id",
      id,
      workspaceId: requestContext.workspace.id,
    });
    return badRequest(message);
  }
}

export async function handleDeleteModel(
  _request: Request,
  env: Env,
  requestContext: RequestContext,
  id: string
): Promise<Response> {
  try {
    await deleteModel(env, requestContext.workspace.id, id);
    return json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("not found")) return notFound("Model");
    if (message.includes("active session")) return badRequest(message);
    logger.error("Model delete failed", error, {
      handler: "handleDeleteModel",
      route: "DELETE /v1/models/:id",
      id,
      workspaceId: requestContext.workspace.id,
    });
    return badRequest(message);
  }
}

interface SetDefaultRequest {
  modelId: string | null;
}

export function handleGetWorkspace(requestContext: RequestContext): Response {
  return json({
    id: requestContext.workspace.id,
    slug: requestContext.workspace.slug,
    name: requestContext.workspace.name,
    description: requestContext.workspace.description,
    role: requestContext.role,
    defaultModelId: requestContext.workspace.defaultModelId,
  });
}

export async function handleSetDefaultModel(
  request: Request,
  env: Env,
  requestContext: RequestContext
): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as SetDefaultRequest;

  try {
    await setWorkspaceDefaultModel(env, requestContext.workspace.id, body.modelId ?? null);
    return json({ ok: true, defaultModelId: body.modelId ?? undefined });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("not found")) return notFound("Model");
    logger.error("Set default model failed", error, {
      handler: "handleSetDefaultModel",
      route: "PUT /v1/workspace/default-model",
      workspaceId: requestContext.workspace.id,
    });
    return badRequest(message);
  }
}
