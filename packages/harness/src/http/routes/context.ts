// Context Route Handler - /v1/context
// Legacy compatibility endpoints

import type { AgentSession } from "../../types.js";
import { json } from "../responses.js";

/**
 * Get context - legacy compatibility endpoint
 * Returns a minimal context object
 */
export async function handleGetContext(): Promise<Response> {
  try {
    // Minimal implementation - for compatibility with existing clients
    const context: AgentSession = {
      id: "main",
      messages: [],
      createdAt: Date.now(),
    };

    return json(context);
  } catch (error) {
    console.error("[handleGetContext] Error:", error);
    return json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}

/**
 * Create new context - legacy compatibility endpoint
 * Returns a new context object
 */
export async function handleNewContext(request: Request): Promise<Response> {
  try {
    const body = (await request.json()) as { parentId?: string };
    const sessionId = crypto.randomUUID();

    const context: AgentSession = {
      id: sessionId,
      parentId: body.parentId,
      messages: [],
      createdAt: Date.now(),
    };

    return json(context);
  } catch (error) {
    return json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
