/**
 * Client for the Secret Broker service binding.
 *
 * The broker owns authorization checks, KEK access, envelope encryption, and
 * encrypted D1 persistence. This client is the main Worker's small typed wrapper
 * around those broker endpoints.
 */

import type { Env } from "../../internal-types/index.js";
import type { AuthorizationContext } from "./secrets.types.js";

export type AuthSession =
  | { type: "immediate"; context: AuthorizationContext }
  | { type: "session"; sessionId: string }
  | { type: "workspace"; workspaceId: string };

export class SecretBrokerClient {
  constructor(private readonly env: Env) {}

  private authParam(auth: AuthSession): AuthorizationContext | { sessionId: string } | { workspaceId: string } {
    if (auth.type === "immediate") return auth.context;
    if (auth.type === "session") return { sessionId: auth.sessionId };
    return { workspaceId: auth.workspaceId };
  }

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

  async put(auth: AuthSession, ref: string, value: string): Promise<string> {
    const result = await this.callBroker("store", {
      auth: this.authParam(auth),
      key: ref,
      value,
    });

    if (!result.ok) {
      throw new Error(`Failed to store secret: ${result.error}`);
    }

    return ref;
  }

  async get(auth: AuthSession, ref: string): Promise<string | undefined> {
    const result = await this.callBroker("get", {
      auth: this.authParam(auth),
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

  async delete(auth: AuthSession, ref: string): Promise<void> {
    const result = await this.callBroker("delete", {
      auth: this.authParam(auth),
      key: ref,
    });

    if (!result.ok) {
      throw new Error(`Failed to delete secret: ${result.error}`);
    }
  }
}

export function createSecretBrokerClient(env: Env): SecretBrokerClient {
  return new SecretBrokerClient(env);
}

const secretBrokerClientCache = new WeakMap<Env, SecretBrokerClient>();

export function getSecretBrokerClient(env: Env): SecretBrokerClient {
  let client = secretBrokerClientCache.get(env);
  if (!client) {
    client = createSecretBrokerClient(env);
    secretBrokerClientCache.set(env, client);
  }
  return client;
}
