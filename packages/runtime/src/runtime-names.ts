export interface RuntimeNames {
  workerName: string;
  testWorkerName: string;
  e2eWorkerPrefix: string;
  workflowName: string;
  testWorkflowName: string;
  e2eWorkflowPrefix: string;
  e2eDatabasePrefix: string;
}

export interface RuntimeNameOverrides extends Partial<RuntimeNames> {}

export interface RuntimeCloudflarePreferences {
  workerName?: string;
  workflowName?: string;
}

export interface RuntimeNameConfigLike {
  name: string;
  cloudflare?: RuntimeCloudflarePreferences;
}

export interface ConfigRuntimeNames {
  workerName: string;
  workflowName: string;
}

export const DEFAULT_RUNTIME_NAMES: RuntimeNames = {
  workerName: "clawflare-runtime",
  testWorkerName: "clawflare-runtime-test",
  e2eWorkerPrefix: "clawflare-runtime-e2e",
  workflowName: "clawflare-agent-workflow",
  testWorkflowName: "clawflare-agent-workflow-test",
  e2eWorkflowPrefix: "clawflare-agent-workflow-e2e",
  e2eDatabasePrefix: "clawflare-e2e",
};

export function resolveRuntimeNames(overrides: RuntimeNameOverrides = {}): RuntimeNames {
  return {
    ...DEFAULT_RUNTIME_NAMES,
    ...overrides,
  };
}

function applyEnvSuffix(name: string, env?: string): string {
  return env ? `${name}-${env}` : name;
}

export function getConfigRuntimeNames(config: RuntimeNameConfigLike, env?: string): ConfigRuntimeNames {
  const preferredWorkerName = config.cloudflare?.workerName ?? config.name;
  const preferredWorkflowName = config.cloudflare?.workflowName ?? `${preferredWorkerName}-workflow`;

  return {
    workerName: applyEnvSuffix(preferredWorkerName, env),
    workflowName: applyEnvSuffix(preferredWorkflowName, env),
  };
}

export function getConfigWorkerName(config: RuntimeNameConfigLike, env?: string): string {
  return getConfigRuntimeNames(config, env).workerName;
}

export function getConfigWorkflowName(config: RuntimeNameConfigLike, env?: string): string {
  return getConfigRuntimeNames(config, env).workflowName;
}
