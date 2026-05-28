/**
 * Secret Store Adapter using Secret Broker
 *
 * This is the client-side interface that the main Clawflare worker uses.
 * It communicates with the Secret Broker worker via service bindings to
 * store and retrieve envelope-encrypted secrets.
 */

import type { Env } from "../../internal-types/index.js";
import type { AuthorizationContext } from "../../secret-broker/types.js";
import { getDataLayer, createJobSnapshot } from "../index.js";
import { createModelConnectionSecretRef, parseModelConnectionSecretRef } from "./secret-refs.js";

/**
 * Auth Session - can be immediate (AuthorizationContext) or async (Job Snapshot)
 */
export type AuthSession =
  | { type: "immediate"; context: AuthorizationContext }
  | { type: "async"; jobId: string };

/**
 * Secret Store Adapter interface
 * Abstracts secret operations from the rest of the codebase
 */
export interface SecretStore {
  /**
   * Store a model connection secret
   * Returns the key that was stored
   */
  putModelConnectionSecret(
    auth: AuthSession,
    args: {
      workspaceId: string;
      connectionId: string;
      key: string;
      value: string;
    }
  ): Promise<string>;

  /**
   * Retrieve a secret by its reference (which is the key)
   */
  getModelConnectionSecret(
    auth: AuthSession,
    ref: string
  ): Promise<string | undefined>;

  /**
   * Delete a secret by its reference
   */
  deleteModelConnectionSecret(
    auth: AuthSession,
    ref: string
  ): Promise<void>;

  /**
   * Get multiple secrets for a connection
   * The refs map contains { secretKey: ref } pairs
   * Returns { secretKey: value } pairs
   */
  getConnectionSecrets(
    auth: AuthSession,
    workspaceId: string,
    connectionId: string,
    keys: string[],
    refs: Record<string, string>
  ): Promise<Record<string, string>>;

  /**
   * Create a job authorization snapshot for async operations (workflows).
   * Returns the jobId to pass to async operations.
   */
  createJobAuthorization(
    userId: string,
    workspaceId: string,
    allowedOperations: string[],
    expiryMs?: number
  ): Promise<string>;
}

/**
 * Secret Broker client using service binding
 */
class SecretBrokerClient implements SecretStore {
  constructor(private readonly env: Env) {}

  private async callBroker(
    endpoint: string,
    body: unknown
  ): Promise<{ ok: true; value?: string } | { ok: false; error: string }> {
    const broker = this.env.SECRET_BROKER;
    if (!broker) {
      throw new Error("SECRET_BROKER service binding not configured");
    }

    const response = await broker.fetch(`https://secret-broker/${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    return response.json() as Promise<{ ok: true; value?: string } | { ok: false; error: string }>;
  }

  async putModelConnectionSecret(
    auth: AuthSession,
    args: {
      workspaceId: string;
      connectionId: string;
      key: string;
      value: string;
    }
  ): Promise<string> {
    const secretKey = createModelConnectionSecretRef(args.workspaceId, args.connectionId, args.key);

    const authParam = auth.type === "immediate"
      ? auth.context
      : { jobId: auth.jobId };

    const result = await this.callBroker("store", {
      auth: authParam,
      key: secretKey,
      value: args.value,
    });

    if (!result.ok) {
      throw new Error(`Failed to store secret: ${result.error}`);
    }

    return secretKey;
  }

  async getModelConnectionSecret(
    auth: AuthSession,
    ref: string
  ): Promise<string | undefined> {
    const parsed = parseModelConnectionSecretRef(ref);
    if (!parsed) {
      throw new Error(`Invalid secret reference format: ${ref}`);
    }

    const authParam = auth.type === "immediate"
      ? auth.context
      : { jobId: auth.jobId };

    const result = await this.callBroker("get", {
      auth: authParam,
      key: ref,
    });

    if (!result.ok) {
      if (result.error === "Secret not found") {
        return undefined;
      }
      throw new Error(`Failed to retrieve secret: ${result.error}`);
    }

    return result.value;
  }

  async deleteModelConnectionSecret(auth: AuthSession, ref: string): Promise<void> {
    const parsed = parseModelConnectionSecretRef(ref);
    if (!parsed) {
      throw new Error(`Invalid secret reference format: ${ref}`);
    }

    const authParam = auth.type === "immediate"
      ? auth.context
      : { jobId: auth.jobId };

    const result = await this.callBroker("delete", {
      auth: authParam,
      key: ref,
    });

    if (!result.ok) {
      throw new Error(`Failed to delete secret: ${result.error}`);
    }
  }

  async getConnectionSecrets(
    auth: AuthSession,
    _workspaceId: string,
    _connectionId: string,
    keys: string[],
    refs: Record<string, string>
  ): Promise<Record<string, string>> {
    const secrets: Record<string, string> = {};

    for (const key of keys) {
      const ref = refs[key];
      if (ref) {
        const value = await this.getModelConnectionSecret(auth, ref);
        if (value) {
          secrets[key] = value;
        }
      }
    }

    return secrets;
  }

  async createJobAuthorization(
    userId: string,
    workspaceId: string,
    allowedOperations: string[],
    expiryMs?: number
  ): Promise<string> {
    const jobId = crypto.randomUUID();
    const snapshot = createJobSnapshot(
      jobId,
      userId,
      workspaceId,
      allowedOperations,
      expiryMs
    );
    
    const data = getDataLayer(this.env);
    await data.jobSnapshots.put(snapshot);
    
    return jobId;
  }
}

/**
 * Create a Secret Store for the given environment
 */
export function createSecretStore(env: Env): SecretStore {
  return new SecretBrokerClient(env);
}

/**
 * Cached secret store accessor
 */
const secretStoreCache = new WeakMap<Env, SecretStore>();

/**
 * Get or create the secret store for the given environment
 */
export function getSecretStore(env: Env): SecretStore {
  let store = secretStoreCache.get(env);
  if (!store) {
    store = createSecretStore(env);
    secretStoreCache.set(env, store);
  }
  return store;
}

// Re-export AuthorizationContext for convenience
export { type AuthorizationContext } from "../../secret-broker/types.js";