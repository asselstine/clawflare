// Session Create Route Handler - POST /v1/session
// Creates a new session and workflow without enqueuing any prompts
// Used for warming up the workflow before user interaction

import type { Env } from "../../internal-types/index.js";
import type { SessionMetadataState } from "../../data/index.js";
import { json } from "../responses.js";
import { timingStart, logTiming } from "../../diagnostics.js";
import { getDataLayer } from "../../data/index.js";

/**
 * Create a new empty session with workflow
 * Returns session ID immediately; workflow is created but idle
 */
export async function handleCreateSession(request: Request, env: Env): Promise<Response> {
  const requestStart = timingStart();

  try {
    const body = (await request.json().catch(() => ({}))) as { sessionId?: string };
    const sessionId = body.sessionId || crypto.randomUUID();
    const workflowId = crypto.randomUUID();

    const data = getDataLayer(env);

    // Initialize session state
    const initialState: SessionMetadataState = {
      id: sessionId,
      workflowId,
      status: "idle" as const,
      nextEventCursor: await data.events.latestCursor(sessionId),
      updatedAt: Date.now(),
      maxQueueSize: 100,
      idleTimeout: "7 days",
    };
    await data.sessions.save(initialState);
    logTiming(env, sessionId, "session.create.saved", requestStart);

    // Create persistent workflow - this warms up the workflow isolate
    await env.AGENT_WORKFLOW.create({
      id: workflowId,
      params: { sessionId },
    });
    logTiming(env, sessionId, "session.create.workflow_done", requestStart);

    return json({
      id: sessionId,
      messages: [],
      createdAt: initialState.updatedAt,
    });
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
