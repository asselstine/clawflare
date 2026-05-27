// AI Providers HTTP Routes
// Returns supported AI providers with their required secrets

import { json } from "../responses.js";
import { getProviders } from "@earendil-works/pi-ai";
import { requiredSecretsForProvider, optionalSecretsForProvider } from "../../model-providers.js";

/**
 * Provider info for API response
 */
export interface ProviderInfo {
  id: string;
  name: string;
  requiredSecrets: string[];
  optionalSecrets: string[];
}

/**
 * Get supported AI providers with their required secrets
 */
export async function handleListProviders(): Promise<Response> {
  try {
    const providerIds = getProviders();

    const providers: ProviderInfo[] = providerIds.map((id) => {
      return {
        id,
        name: id,
        requiredSecrets: requiredSecretsForProvider(id),
        optionalSecrets: optionalSecretsForProvider(id),
      };
    });

    return json({ providers });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return json({ error: message }, { status: 500 });
  }
}
