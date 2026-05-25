// Server Names - Simple constants for internal use
// Config-based naming removed in Phase 4

/**
 * Default server names used by the Clawflare server
 * These are fixed values, not derived from config
 */
export interface ServerNames {
  workerName: string;
  testWorkerName: string;
  e2eWorkerPrefix: string;
  workflowName: string;
  testWorkflowName: string;
  e2eWorkflowPrefix: string;
  e2eDatabasePrefix: string;
}

export const DEFAULT_SERVER_NAMES: ServerNames = {
  workerName: "clawflare-server",
  testWorkerName: "clawflare-server-test",
  e2eWorkerPrefix: "clawflare-server-e2e",
  workflowName: "clawflare-agent-workflow",
  testWorkflowName: "clawflare-agent-workflow-test",
  e2eWorkflowPrefix: "clawflare-agent-workflow-e2e",
  e2eDatabasePrefix: "clawflare-e2e",
};

/**
 * Resolve server names with optional overrides
 * (Kept for backward compatibility with e2e tests)
 */
export function resolveServerNames(overrides: Partial<ServerNames> = {}): ServerNames {
  return {
    ...DEFAULT_SERVER_NAMES,
    ...overrides,
  };
}
