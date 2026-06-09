import type { E2ETestContext, E2ETestRunner } from "./support.js";

interface PublicModel {
  id: string;
  provider: string;
  modelName: string;
  displayName?: string;
  configuredSecrets?: string[];
}

interface ModelListResponse {
  models?: PublicModel[];
  defaultModelId?: string;
}

interface ModelResolveResponse {
  id?: string;
  provider?: string;
  modelName?: string;
  secrets?: unknown;
}

interface ModelMutationResponse {
  model?: PublicModel;
}

interface DeleteModelResponse {
  ok?: boolean;
}

export async function runModelTests(runner: E2ETestRunner, ctx: E2ETestContext): Promise<void> {
  await runner.runTest("Models: list and resolve default model", async () => {
    const list = await ctx.authedJson<ModelListResponse>("/v1/models");
    const defaultModel = list.models?.find((model) => model.id === list.defaultModelId) ?? list.models?.[0];
    if (!defaultModel) throw new Error(`Expected at least one configured model: ${JSON.stringify(list)}`);

    const resolved = await ctx.authedJson<ModelResolveResponse>(`/v1/models/${defaultModel.id}`);
    if (resolved.id !== defaultModel.id || resolved.provider !== defaultModel.provider) {
      throw new Error(`Resolved model mismatch: ${JSON.stringify({ list, resolved })}`);
    }
    if ("secrets" in resolved) {
      throw new Error(`Model resolution response must not expose secrets: ${JSON.stringify(resolved)}`);
    }
  });

  await runner.runTest("Models: create, update, and delete disposable model", async () => {
    const created = await ctx.authedJson<ModelMutationResponse>("/v1/models", {
      method: "POST",
      body: JSON.stringify({
        provider: "openai",
        providerDisplayName: "E2E disposable model provider",
        displayName: "E2E disposable model",
        modelName: "gpt-4o-mini",
        secrets: { OPENAI_API_KEY: "e2e-test-key" },
        setAsDefault: false,
      }),
    });
    const modelId = created.model?.id;
    if (!modelId || created.model?.provider !== "openai") {
      throw new Error(`Model create failed: ${JSON.stringify(created)}`);
    }

    const updated = await ctx.authedJson<ModelMutationResponse>(`/v1/models/${modelId}`, {
      method: "PATCH",
      body: JSON.stringify({
        displayName: "E2E renamed model",
        config: { temperature: 0 },
      }),
    });
    if (updated.model?.id !== modelId || updated.model.displayName !== "E2E renamed model") {
      throw new Error(`Model update failed: ${JSON.stringify(updated)}`);
    }

    const deleted = await ctx.authedJson<DeleteModelResponse>(`/v1/models/${modelId}`, {
      method: "DELETE",
    });
    if (!deleted.ok) throw new Error(`Model delete failed: ${JSON.stringify(deleted)}`);
  });
}
