import type { E2ETestContext, E2ETestRunner } from "./support.js";

interface ProviderCatalogResponse {
  providers?: Array<{
    id: string;
    requiredSecrets: string[];
  }>;
}

interface ConfiguredProviderResponse {
  providers?: Array<{
    id: string;
    provider: string;
    configuredSecrets?: string[];
  }>;
}

interface CreateProviderResponse {
  provider?: {
    id: string;
    provider: string;
    configuredSecrets?: string[];
  };
}

interface DeleteProviderResponse {
  ok?: boolean;
  providerId?: string;
  deletedModelIds?: string[];
}

interface ProviderModelsResponse {
  provider?: string;
  models?: Array<{
    id: string;
    provider: string;
  }>;
}

export async function runProviderTests(runner: E2ETestRunner, ctx: E2ETestContext): Promise<void> {
  await runner.runTest("Providers: list supported providers", async () => {
    const data = await ctx.authedJson<ProviderCatalogResponse>("/v1/providers");
    const openai = data.providers?.find((provider) => provider.id === "openai");
    if (!openai) throw new Error(`Expected openai provider in catalog: ${JSON.stringify(data)}`);
    if (!openai.requiredSecrets.includes("OPENAI_API_KEY")) {
      throw new Error(`Expected openai required secret metadata: ${JSON.stringify(openai)}`);
    }
  });

  await runner.runTest("Providers: list configured providers", async () => {
    const data = await ctx.authedJson<ConfiguredProviderResponse>("/v1/providers/configured");
    const seeded = data.providers?.find((provider) => provider.provider === "amazon-bedrock");
    if (!seeded) throw new Error(`Expected seeded amazon-bedrock provider: ${JSON.stringify(data)}`);
  });

  await runner.runTest("Providers: list catalog models for provider", async () => {
    const data = await ctx.authedJson<ProviderModelsResponse>("/v1/providers/openai/models");
    if (data.provider !== "openai" || !data.models?.some((model) => model.provider === "openai")) {
      throw new Error(`Expected openai model catalog: ${JSON.stringify(data)}`);
    }
  });

  await runner.runTest("Providers: configure and delete disposable provider", async () => {
    const created = await ctx.authedJson<CreateProviderResponse>("/v1/providers", {
      method: "POST",
      body: JSON.stringify({
        provider: "openai",
        providerDisplayName: "E2E disposable provider",
        secrets: { OPENAI_API_KEY: "e2e-test-key" },
        createDefaultModel: false,
        setAsDefault: false,
      }),
    });
    const providerId = created.provider?.id;
    if (!providerId || created.provider?.provider !== "openai") {
      throw new Error(`Provider create failed: ${JSON.stringify(created)}`);
    }
    if (!created.provider.configuredSecrets?.includes("OPENAI_API_KEY")) {
      throw new Error(`Provider response should expose configured secret names only: ${JSON.stringify(created)}`);
    }

    const deleted = await ctx.authedJson<DeleteProviderResponse>(`/v1/providers/${providerId}`, {
      method: "DELETE",
    });
    if (!deleted.ok || deleted.providerId !== providerId) {
      throw new Error(`Provider delete failed: ${JSON.stringify(deleted)}`);
    }
  });
}
