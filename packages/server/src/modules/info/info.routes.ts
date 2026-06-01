import { Hono } from "hono";
import type { AppBindings } from "../../http/app-bindings.js";
import { requireAuth } from "../../middleware/auth.js";
import type { Env } from "../../internal-types/index.js";
import { json, serverError } from "../../http/responses.js";
import { getSupportedProviders } from "../providers/providers.catalog.js";

export const infoRoutes = new Hono<AppBindings>();

infoRoutes.use("*", requireAuth);
infoRoutes.get("/", (c) =>
  handleGetInfo(c.env, { workspaceId: c.get("requestContext")!.workspace.id })
);

// Info Route Handler - /v1/info
// Returns server information

interface InfoRequestContext {
  workspaceId: string;
}

/**
 * Get server info (supported providers, model connection support)
 * Also returns workspace-specific info if authenticated
 */
export async function handleGetInfo(
  env: Env,
  requestContext?: InfoRequestContext
): Promise<Response> {
  try {
    const contextWindow = 128000;

    const response: {
      contextWindow: number;
      supportsWorkspaceModelConnections: boolean;
      supportedProviders: string[];
      workspace?: {
        hasModelConnections: boolean;
      };
    } = {
      contextWindow,
      supportsWorkspaceModelConnections: true,
      supportedProviders: getSupportedProviders(),
    };

    // Include workspace-specific info if available
    if (requestContext?.workspaceId) {
      const { hasModelConnections } = await import("../model-connections/model-connections.service.js");
      response.workspace = {
        hasModelConnections: await hasModelConnections(env, requestContext.workspaceId),
      };
    }

    return json(response);
  } catch (error) {
    return serverError(error instanceof Error ? error.message : "Unknown error");
  }
}
