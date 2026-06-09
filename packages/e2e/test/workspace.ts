import type { E2ETestContext, E2ETestRunner } from "./support.js";

interface WorkspaceResponse {
  id?: string;
  slug?: string;
  name?: string;
  role?: string;
  defaultModelId?: string;
}

interface ModelListResponse {
  models?: Array<{ id: string }>;
  defaultModelId?: string;
}

interface SetDefaultModelResponse {
  ok?: boolean;
  defaultModelId?: string;
}

export async function runWorkspaceTests(runner: E2ETestRunner, ctx: E2ETestContext): Promise<void> {
  await runner.runTest("Workspace: get current workspace", async () => {
    const workspace = await ctx.authedJson<WorkspaceResponse>("/v1/workspace");
    if (workspace.slug !== "e2e-test") {
      throw new Error(`Expected e2e-test workspace, got: ${JSON.stringify(workspace)}`);
    }
    if (!workspace.defaultModelId) {
      throw new Error(`Expected default model id, got: ${JSON.stringify(workspace)}`);
    }
  });

  await runner.runTest("Workspace: set default model", async () => {
    const models = await ctx.authedJson<ModelListResponse>("/v1/models");
    const modelId = models.defaultModelId ?? models.models?.[0]?.id;
    if (!modelId) throw new Error(`No model available to set as default: ${JSON.stringify(models)}`);

    const updated = await ctx.authedJson<SetDefaultModelResponse>("/v1/workspace/default-model", {
      method: "PUT",
      body: JSON.stringify({ modelId }),
    });
    if (!updated.ok || updated.defaultModelId !== modelId) {
      throw new Error(`Default model update failed: ${JSON.stringify(updated)}`);
    }
  });
}
