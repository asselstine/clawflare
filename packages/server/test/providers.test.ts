import { describe, expect, it } from "vitest";
import { handleListProviderModels, handleListProviders } from "../src/modules/providers/providers.routes.js";
import { validateModelConnectionInput } from "../src/modules/model-connections/model-connections.validation.js";

describe("providers routes", () => {
  it("lists providers with server-defined secrets", async () => {
    const response = await handleListProviders();

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      providers: Array<{ id: string; requiredSecrets: string[] }>;
    };
    const bedrock = body.providers.find((provider) => provider.id === "amazon-bedrock");

    expect(bedrock?.requiredSecrets).toEqual(["AWS_BEARER_TOKEN_BEDROCK"]);
  });

  it("lists models under the selected provider", async () => {
    const response = await handleListProviderModels("amazon-bedrock");

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      provider: string;
      models: Array<{ id: string; provider: string }>;
    };

    expect(body.provider).toBe("amazon-bedrock");
    expect(body.models.length).toBeGreaterThan(10);
    expect(body.models.every((model) => model.provider === "amazon-bedrock")).toBe(true);
  });

  it("rejects unknown models for a provider", () => {
    const result = validateModelConnectionInput({
      provider: "amazon-bedrock",
      modelName: "not-a-real-bedrock-model",
      secrets: {
        AWS_BEARER_TOKEN_BEDROCK: "token",
      },
    });

    expect(result).toEqual({
      ok: false,
      error: 'Unknown model "not-a-real-bedrock-model" for provider "amazon-bedrock"',
    });
  });
});
