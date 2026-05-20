import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from "cloudflare:workers";
import type {
  Env,
  SessionInputEvent,
} from "./internal-types/index.js";

/**
 * Persistent workflow params
 */
export interface PersistentWorkflowParams {
  sessionId: string;
}

/**
 * Persistent session workflow - runs continuously per session
 */
export class PersistentSessionWorkflow extends WorkflowEntrypoint<Env, PersistentWorkflowParams> {
  async run(_event: Readonly<WorkflowEvent>, _step: WorkflowStep): Promise<{
    ok: boolean;
    sessionId: string;
    reason: string;
  }> {
    // Access sessionId from the event payload or create options
    const _sessionId = (_event as unknown as { payload?: { sessionId?: string } }).payload?.sessionId ?? "unknown";

    // Main event loop - process inputs until close
    let shouldContinue = true;

    while (shouldContinue) {
      // Wait for input event
      const _inputEvent = await _step.do("wait-input", async () => {
        return { type: "prompt", content: "" } as SessionInputEvent;
      });

      if (_inputEvent.type === "close") {
        shouldContinue = false;
        await markSessionActive(_step, _sessionId, false);
        return { ok: true, sessionId: _sessionId, reason: "closed" };
      }

      // Process the prompt
      await _step.do("process-prompt", async () => {
        // Process the input
        return { processed: true };
      });
    }

    return { ok: true, sessionId: _sessionId, reason: "completed" };
  }
}

/**
 * Mark session active/inactive
 */
async function markSessionActive(
  step: WorkflowStep,
  sessionId: string,
  _active: boolean
): Promise<void> {
  await step.do("mark-active", async () => {
    // In real implementation, this would call the session store
    return { active: _active };
  });
}

// Re-export for compatibility
export type { AgentRuntimeState } from "./agent.js";
