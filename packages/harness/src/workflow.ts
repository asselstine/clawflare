// Workflow entry point - simplified orchestration
// For full persistent workflow, see persistent-workflow.ts

import type { Env } from "./internal-types/index.js";

export interface WorkflowInput {
  sessionId: string;
  type: "prompt" | "steer" | "close";
  content?: string;
}

export interface WorkflowResult {
  ok: boolean;
  sessionId: string;
  status: string;
}

/**
 * Execute a workflow step.
 * This is a simplified entry point; the actual workflow is in persistent-workflow.ts
 */
export async function executeWorkflowStep(
  _env: Env,
  input: WorkflowInput
): Promise<WorkflowResult> {
  // The actual workflow execution is handled by PersistentSessionWorkflow
  // This function exists for testing and direct invocation

  return {
    ok: true,
    sessionId: input.sessionId,
    status: "completed",
  };
}
