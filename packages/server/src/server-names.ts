export interface ServerNames {
  workerName: string;
  testWorkerName: string;
  e2eWorkerPrefix: string;
  workflowName: string;
  testWorkflowName: string;
  e2eWorkflowPrefix: string;
  e2eDatabasePrefix: string;
}

export interface ServerNameOverrides extends Partial<ServerNames> {}

export interface ServerCloudflarePreferences {
  workerName?: string;
  workflowName?: string;
}

export interface ServerNameConfigLike {
  name: string;
  cloudflare?: ServerCloudflarePreferences;
}

export interface ConfigServerNames {
  workerName: string;
  workflowName: string;
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

export function resolveServerNames(overrides: ServerNameOverrides = {}): ServerNames {
  return {
    ...DEFAULT_SERVER_NAMES,
    ...overrides,
  };
}

function applyEnvSuffix(name: string, env?: string): string {
  return env ? `${name}-${env}` : name;
}

export function getConfigServerNames(config: ServerNameConfigLike, env?: string): ConfigServerNames {
  const preferredWorkerName = config.cloudflare?.workerName ?? config.name;
  const preferredWorkflowName = config.cloudflare?.workflowName ?? `${preferredWorkerName}-workflow`;

  return {
    workerName: applyEnvSuffix(preferredWorkerName, env),
    workflowName: applyEnvSuffix(preferredWorkflowName, env),
  };
}

export function getConfigWorkerName(config: ServerNameConfigLike, env?: string): string {
  return getConfigServerNames(config, env).workerName;
}

export function getConfigWorkflowName(config: ServerNameConfigLike, env?: string): string {
  return getConfigServerNames(config, env).workflowName;
}
