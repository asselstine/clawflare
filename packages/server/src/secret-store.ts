// Cloudflare Secret Store Adapter
// Manages workspace-scoped model connection secrets

import type { Env } from "./internal-types/index.js";

/**
 * Secret Store Adapter interface
 * Abstracts Cloudflare Secret Store operations
 */
export interface SecretStoreAdapter {
  /**
   * Store a model connection secret
   * Returns the secret reference/name
   */
  putModelConnectionSecret(args: {
    workspaceId: string;
    connectionId: string;
    key: string;
    value: string;
  }): Promise<string>;

  /**
   * Retrieve a secret by its reference/name
   */
  getModelConnectionSecret(ref: string): Promise<string | undefined>;

  /**
   * Delete a secret by its reference/name
   */
  deleteModelConnectionSecret(ref: string): Promise<void>;

  /**
   * Get multiple secrets for a connection
   */
  getConnectionSecrets(
    workspaceId: string,
    connectionId: string,
    keys: string[],
    refs: Record<string, string>
  ): Promise<Record<string, string>>;
}

/**
 * Create a deterministic secret name for a model connection secret
 */
function createSecretName(
  workspaceId: string,
  connectionId: string,
  key: string
): string {
  // Format: workspaces/{workspaceId}/model-connections/{connectionId}/{key}
  // Using underscores instead of / to avoid path-like issues
  return `workspaces_${workspaceId}_mc_${connectionId}_${key}`;
}

/**
 * Secret Store using Cloudflare Secret Store binding
 * This is the production implementation
 */
class CloudflareSecretStore implements SecretStoreAdapter {
  constructor(private readonly env: Env) {}

  async putModelConnectionSecret(args: {
    workspaceId: string;
    connectionId: string;
    key: string;
    value: string;
  }): Promise<string> {
    const secretName = createSecretName(args.workspaceId, args.connectionId, args.key);

    // Cloudflare Secret Store binding API
    // The exact API depends on the binding type, this is a placeholder
    const store = this.env.MODEL_SECRET_STORE;
    if (!store) {
      throw new Error("MODEL_SECRET_STORE binding not configured");
    }

    // Placeholder for Secret Store API
    // Real implementation will depend on Cloudflare's specific binding
    // @ts-expect-error - Secret Store API not yet typed
    if (typeof store.put === "function") {
      // @ts-expect-error
      await store.put(secretName, args.value);
    }

    return secretName;
  }

  async getModelConnectionSecret(ref: string): Promise<string | undefined> {
    const store = this.env.MODEL_SECRET_STORE;
    if (!store) {
      return undefined;
    }

    // @ts-expect-error - Secret Store API not yet typed
    if (typeof store.get === "function") {
      // @ts-expect-error
      const result = await store.get(ref);
      return result;
    }

    return undefined;
  }

  async deleteModelConnectionSecret(ref: string): Promise<void> {
    const store = this.env.MODEL_SECRET_STORE;
    if (!store) {
      throw new Error("MODEL_SECRET_STORE binding not configured");
    }

    // @ts-expect-error - Secret Store API not yet typed
    if (typeof store.delete === "function") {
      // @ts-expect-error
      await store.delete(ref);
    }
  }

  async getConnectionSecrets(
    _workspaceId: string,
    _connectionId: string,
    keys: string[],
    refs: Record<string, string>
  ): Promise<Record<string, string>> {
    const secrets: Record<string, string> = {};

    for (const key of keys) {
      const ref = refs[key];
      if (ref) {
        const value = await this.getModelConnectionSecret(ref);
        if (value) {
          secrets[key] = value;
        }
      }
    }

    return secrets;
  }
}

/**
 * Create a Secret Store adapter for the given environment
 */
export function createSecretStore(env: Env): SecretStoreAdapter {
  return new CloudflareSecretStore(env);
}

/**
 * Cached secret store accessor
 */
const secretStoreCache = new WeakMap<Env, SecretStoreAdapter>();

/**
 * Get or create the secret store for the given environment
 */
export function getSecretStore(env: Env): SecretStoreAdapter {
  let store = secretStoreCache.get(env);
  if (!store) {
    store = createSecretStore(env);
    secretStoreCache.set(env, store);
  }
  return store;
}
