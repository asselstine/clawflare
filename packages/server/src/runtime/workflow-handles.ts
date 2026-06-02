type DisposableWorkflowInstance = WorkflowInstance & {
  dispose?: () => void | Promise<void>;
};

async function disposeWorkflowInstance(instance: WorkflowInstance): Promise<void> {
  await (instance as DisposableWorkflowInstance).dispose?.();
}

export async function createWorkflowInstance(
  workflow: Workflow,
  options: Parameters<Workflow["create"]>[0]
): Promise<void> {
  const instance = await workflow.create(options);
  await disposeWorkflowInstance(instance);
}

export async function withWorkflowInstance<T>(
  workflow: Workflow,
  workflowId: string,
  callback: (instance: WorkflowInstance) => Promise<T>
): Promise<T> {
  const instance = await workflow.get(workflowId);
  try {
    return await callback(instance);
  } finally {
    await disposeWorkflowInstance(instance);
  }
}
