// Info Route Handler - /v1/info
// Returns server information

import type { Env } from "../../internal-types/index.js";
import { json, serverError } from "../responses.js";
import { normalizeBedrockBearerToken } from "../../agent-config.js";
import { getSupportedProviders } from "../../model-providers.js";

/**
 * Get server info (provider, model, context window, model connection support)
 */
export async function handleGetInfo(env: Env): Promise<Response> {
  try {
    const provider = env.AI_PROVIDER || "amazon-bedrock";
    const model = env.AI_MODEL || "minimax.minimax-m2.5";
    const contextWindow = 128000;
    const rawBedrockToken = env.AWS_BEARER_TOKEN_BEDROCK || "";
    const normalizedBedrockToken = normalizeBedrockBearerToken(rawBedrockToken) || "";

    return json({
      provider,
      model,
      contextWindow,
      mockAi: env.MOCK_AI,
      supportsWorkspaceModelConnections: true,
      supportedProviders: getSupportedProviders(),
      bedrockAuth: {
        configured: normalizedBedrockToken.length > 0,
        rawLength: rawBedrockToken.length,
        normalizedLength: normalizedBedrockToken.length,
        hadBearerPrefix: /\s*Bearer\s+/i.test(rawBedrockToken),
        fingerprint: normalizedBedrockToken ? await sha256Prefix(normalizedBedrockToken) : undefined,
      },
    });
  } catch (error) {
    return serverError(error instanceof Error ? error.message : "Unknown error");
  }
}

async function sha256Prefix(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash))
    .slice(0, 8)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
