// Tools Route Handler - /v1/tools
// Lists available agent tools

import type { Env } from "../../internal-types/index.js";
import { createTools } from "../../tools/index.js";
import { json, serverError } from "../responses.js";
import { logger } from "../../logger.js";

/**
 * List available tools
 */
export async function handleListTools(env: Env, ctx: ExecutionContext): Promise<Response> {
  try {
    const tools = createTools(env, ctx);
    return json({ tools });
  } catch (error) {
    logger.error("List tools failed", error, {
      handler: "handleListTools",
      route: "GET /v1/tools",
    });
    return serverError(error instanceof Error ? error.message : "Unknown error");
  }
}
