// Session Create Route Handler - POST /v1/session
// Creates a new session and workflow without enqueuing any prompts
// Used for warming up the workflow before user interaction

import type { Env } from "../../internal-types/index.js";
import type { SessionMetadataState } from "../../data/index.js";
import { json, badRequest } from "../responses.js";
import { timingStart, logTiming } from "../../diagnostics.js";
import { getDataLayer } from "../../data/index.js";
import type { RequestContext } from "../request-context.js";
import { resolveModelConnectionForNewSession } from "../../model-connection-service.js";

/**
 * Create a new empty session with workflow
 * Returns session ID immediately; workflow is created but idle
 */
export async function handleCreateSession(
  request: Request,
  env: Env,
  requestContext: RequestContext
): Promise<Response> {
  const requestStart = timingStart();

  try {
    const body = (await request.json().catch(() => ({}))) as {
      sessionId?: string;
      modelConnectionId?: string;
    };
    const sessionId = body.sessionId || crypto.randomUUID();
    const workflowId = crypto.randomUUID();
    // Use workspace from request context
    const workspaceId = requestContext.workspace.id;

    const data = getDataLayer(env);

    // Resolve model connection for the session
    const resolvedModel = await resolveModelConnectionForNewSession(
      env,
      workspaceId,
      body.modelConnectionId
    );

    // If explicit model requested but not found, return error
    if (body.modelConnectionId && !resolvedModel) {
      return badRequest(
        `Model connection "${body.modelConnectionId}" not found or not available`
      );
    }

    // Initialize session state with workspace and model info
    const initialState: SessionMetadataState = {
      id: sessionId,
      workspaceId,
      workflowId,
      status: "idle" as const,
      nextEventCursor: await data.events.latestCursor(sessionId),
      updatedAt: Date.now(),
      maxQueueSize: 100,
      idleTimeout: "7 days",
      modelConnectionId: resolvedModel?.id,
      modelProvider: resolvedModel?.provider,
      modelName: resolvedModel?.modelName,
    };
    await data.sessions.save(initialState);
    logTiming(env, sessionId, "session.create.saved", requestStart);

    // Create persistent workflow - this warms up the workflow isolate
    await env.AGENT_WORKFLOW.create({
      id: workflowId,
      params: { sessionId },
    });
    logTiming(env, sessionId, "session.create.workflow_done", requestStart);

    const response: {
      id: string;
      workspaceId: string;
      messages: [];
      createdAt: number;
      modelConnection?: { id: string; provider: string; modelName: string };
    } = {
      id: sessionId,
      workspaceId,
      messages: [],
      createdAt: initialState.updatedAt,
    };

    // Include model connection info if available
    if (resolvedModel) {
      response.modelConnection = {
        id: resolvedModel.id,
        provider: resolvedModel.provider,
        modelName: resolvedModel.modelName,
      };
    }

    return json(response);
  } catch (error) {
    logTiming(env, "unknown", "session.create.error", requestStart, {
      error: error instanceof Error ? error.message : String(error),
    });
    console.error("[handleCreateSession] Error:", error);
    return json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
