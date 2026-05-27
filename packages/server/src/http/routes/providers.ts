// AI Providers HTTP Routes
// Returns supported AI providers from pi-ai

import { json } from "../responses.js";
import { getProviders, findEnvKeys } from "@earendil-works/pi-ai";

/**
 * Provider info from pi-ai
 */
export interface ProviderInfo {
  id: string;
  name: string;
  requiredSecrets: string[];
}

/**
 * Get supported AI providers with their required secrets
 */
export async function handleListProviders(): Promise<Response> {
  try {
    const providerIds = getProviders();

    const providers: ProviderInfo[] = providerIds.map((id) => {
      const envKeys = findEnvKeys(id) ?? [];
      return {
        id,
        name: id, // pi-ai uses the provider ID as the display name
        requiredSecrets: envKeys,
      };
    });

    return json({ providers });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return json({ error: message }, { status: 500 });
  }
}
