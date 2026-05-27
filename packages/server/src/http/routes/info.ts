// Info Route Handler - /v1/info
// Returns server information

import type { Env } from "../../internal-types/index.js";
import { json, serverError } from "../responses.js";
import { getSupportedProviders } from "../../model-providers.js";

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
      const { hasModelConnections } = await import("../../model-connection-service.js");
      response.workspace = {
        hasModelConnections: await hasModelConnections(env, requestContext.workspaceId),
      };
    }

    return json(response);
  } catch (error) {
    return serverError(error instanceof Error ? error.message : "Unknown error");
  }
}
