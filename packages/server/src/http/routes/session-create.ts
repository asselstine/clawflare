// Session Create Route Handler - POST /v1/session
// Creates a new session and workflow without enqueuing any prompts
// Used for warming up the workflow before user interaction

import type { Env } from "../../internal-types/index.js";
import type { SessionMetadataState } from "../../data/index.js";
import type { ModelProvider } from "../../types.js";
import { json, badRequest } from "../responses.js";
import { timingStart, logTiming } from "../../diagnostics.js";
import { getDataLayer } from "../../data/index.js";
import type { RequestContext } from "../request-context.js";
import { resolveModelConnectionForNewSession } from "../../model-connection-service.js";
import { getSecretStore } from "../../secret-store.js";
import { logger } from "../../logger.js";

/**
 * Create an immediate authorization context from the request context
 */
function createAuthSession(ctx: RequestContext) {
  return {
    type: "immediate" as const,
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
    const secretStore = getSecretStore(env);

    // Create authorization context for this request
    const auth = createAuthSession(requestContext);

    // Resolve model connection for the session
    const resolvedModel = await resolveModelConnectionForNewSession(
      env,
      workspaceId,
      body.modelConnectionId,
      auth
    );

    // If explicit model requested but not found, return error
    if (body.modelConnectionId && !resolvedModel) {
      return badRequest(
        `Model connection "${body.modelConnectionId}" not found or not available`
      );
    }

    // Create job authorization snapshot for the workflow
    // This allows the workflow to access secrets without storing the user's token
    const workflowAuthJobId = await secretStore.createJobAuthorization(
      requestContext.user.id,
      workspaceId,
      ["get"], // Only allow reading secrets
      60 * 60 * 1000 // 1 hour expiry
    );

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
      modelProvider: (resolvedModel?.provider as ModelProvider | undefined),
      modelName: resolvedModel?.modelName,
      workflowAuthJobId,
    };
    await data.sessions.save(initialState);

    // Create persistent workflow (initially idle)
    await env.AGENT_WORKFLOW.create({
      id: workflowId,
      params: { sessionId },
    });
    logTiming(env, sessionId, "session.create.workflows.create.done", requestStart);

    logTiming(env, sessionId, "session.create.response", requestStart);

    return json({
      id: sessionId,
      workspaceId,
      eventCursor: initialState.nextEventCursor,
      createdAt: Date.now(),
      modelConnection: resolvedModel
        ? {
            id: resolvedModel.id,
            provider: resolvedModel.provider,
            modelName: resolvedModel.modelName,
          }
        : undefined,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("Session creation failed", error, {
      handler: "handleCreateSession",
      route: "POST /v1/session",
      workspaceId: requestContext.workspace.id,
    });
    return badRequest(message);
  }
}