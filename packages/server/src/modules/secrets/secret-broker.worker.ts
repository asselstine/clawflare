/**
 * Secret Broker Worker
 *
 * A separate Worker service that manages envelope-encrypted secrets.
 *
 * Authentication Flow:
 * 1. Main Worker validates user's access token/session
 * 2. Main Worker derives AuthorizationContext (userId, workspaceId, authTime, etc.)
 * 3. Main Worker calls Secret Broker via Service Binding (mTLS authenticated)
 * 4. Broker validates:
 *    a. Auth context format and freshness
 *    b. User has workspace membership
 *    c. Workspace exists
 *
 * For Workflows (Async Operations):
 * 1. Job is created with Authorization Snapshot (expiring grant)
 * 2. Workflow references jobId when calling Secret Broker
 * 3. Broker validates job exists, not expired, and operation is allowed
 * 4. Broker checks workspace/user still valid
 *
 * Encryption:
 * - Each secret: unique DEK, AES-256-GCM
 * - DEK encryption: KEK from Cloudflare Secret Store
 * - Storage: D1 (edek + ciphertext + nonce)
 */

import type { Env } from "../../internal-types/index.js";
import { getEncryptedSecretRepository } from "../../data/encrypted-secrets.js";
import {
  envelopeEncrypt,
  envelopeDecrypt,
  importKEK,
  decodeBase64,
  generateKEK,
  encodeBase64,
} from "./secrets.crypto.js";
import { validateAuthorization, validateJobAuthorization } from "./secrets.auth.js";
import {
  type StoreSecretRequest,
  type GetSecretRequest,
  type DeleteSecretRequest,
  type SecretResponse,
  type ErrorResponse,
  type AuthorizationContext,
} from "./secrets.types.js";

// =============================================================================
// KEK Management
// =============================================================================

const KEK_SECRET_NAME = "CLAWFLARE_KEK";

/**
 * Load or generate the KEK from Cloudflare Secret Store.
 */
async function loadKEK(env: Env): Promise<CryptoKey> {
  if (!env.MODEL_SECRET_STORE) {
    throw new Error("Cloudflare Secret Store binding (MODEL_SECRET_STORE) not configured");
  }

  // Try to retrieve existing KEK
  const store = env.MODEL_SECRET_STORE as {
    get?: (name: string) => Promise<{ text(): Promise<string> } | null>
  };
  let kekBase64: string | null = null;

  if (typeof store.get === "function") {
    const secret = await store.get(KEK_SECRET_NAME);
    if (secret) {
      kekBase64 = await secret.text();
    }
  }

  if (kekBase64) {
    const kekBytes = decodeBase64(kekBase64);
    return importKEK(kekBytes);
  }

  // Generate and store new KEK
  const newKEKBytes = generateKEK();
  const newKEKBase64 = encodeBase64(newKEKBytes);

  const putStore = env.MODEL_SECRET_STORE as {
    put?: (name: string, value: string) => Promise<void>
  };
  if (typeof putStore.put === "function") {
    await putStore.put(KEK_SECRET_NAME, newKEKBase64);
  } else {
    throw new Error("Cloudflare Secret Store does not support put operation");
  }

  return importKEK(newKEKBytes);
}

// =============================================================================
// Request Handlers
// =============================================================================

/**
 * Parse authorization from request.
 * Can be AuthorizationContext (sync) or job reference (async).
 */
function parseAuth(auth: unknown): { type: "context"; context: AuthorizationContext } | { type: "job"; jobId: string } | null {
  if (!auth || typeof auth !== "object") return null;

  const a = auth as Record<string, unknown>;

  // Job reference: { jobId: string }
  if ("jobId" in a && typeof a.jobId === "string") {
    return { type: "job", jobId: a.jobId };
  }

  // Authorization context: { userId, workspaceId, authTime, requestId, version }
  if (
    "userId" in a && typeof a.userId === "string" &&
    "workspaceId" in a && typeof a.workspaceId === "string" &&
    "authTime" in a && typeof a.authTime === "number" &&
    "requestId" in a && typeof a.requestId === "string" &&
    "version" in a && typeof a.version === "number"
  ) {
    return {
      type: "context",
      context: {
        userId: a.userId,
        workspaceId: a.workspaceId,
        authTime: a.authTime,
        requestId: a.requestId,
        version: a.version,
      },
    };
  }

  return null;
}

/**
 * Store a secret
 */
async function handleStore(
  request: StoreSecretRequest,
  env: Env,
  kek: CryptoKey
): Promise<SecretResponse | ErrorResponse> {
  const parsedAuth = parseAuth(request.auth);
  if (!parsedAuth) {
    return { ok: false, error: "Invalid authorization" };
  }

  // Validate authorization
  let authResult;
  if (parsedAuth.type === "context") {
    authResult = await validateAuthorization(env, parsedAuth.context);
  } else {
    authResult = await validateJobAuthorization(env, parsedAuth.jobId, "store");
  }

  if (!authResult.valid) {
    return { ok: false, error: authResult.error };
  }

  try {
    const repo = getEncryptedSecretRepository(env.DB);
    const envelope = await envelopeEncrypt(request.value, kek);
    await repo.put(authResult.result.workspaceId, request.key, envelope);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: `Failed to store secret: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Get a secret
 */
async function handleGet(
  request: GetSecretRequest,
  env: Env,
  kek: CryptoKey
): Promise<SecretResponse | ErrorResponse> {
  const parsedAuth = parseAuth(request.auth);
  if (!parsedAuth) {
    return { ok: false, error: "Invalid authorization" };
  }

  // Validate authorization
  let authResult;
  if (parsedAuth.type === "context") {
    authResult = await validateAuthorization(env, parsedAuth.context);
  } else {
    authResult = await validateJobAuthorization(env, parsedAuth.jobId, "get");
  }

  if (!authResult.valid) {
    return { ok: false, error: authResult.error };
  }

  try {
    const repo = getEncryptedSecretRepository(env.DB);
    const record = await repo.get(authResult.result.workspaceId, request.key);

    if (!record) {
      return { ok: false, error: "Secret not found" };
    }

    const envelope = {
      v: record.v,
      edek: record.edek,
      ct: record.ct,
      nonce: record.nonce,
      createdAt: record.createdAt,
    };

    const value = await envelopeDecrypt(envelope, kek);
    return { ok: true, value };
  } catch (error) {
    return {
      ok: false,
      error: `Failed to retrieve secret: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Delete a secret
 */
async function handleDelete(
  request: DeleteSecretRequest,
  env: Env
): Promise<SecretResponse | ErrorResponse> {
  const parsedAuth = parseAuth(request.auth);
  if (!parsedAuth) {
    return { ok: false, error: "Invalid authorization" };
  }

  // Validate authorization
  let authResult;
  if (parsedAuth.type === "context") {
    authResult = await validateAuthorization(env, parsedAuth.context);
  } else {
    authResult = await validateJobAuthorization(env, parsedAuth.jobId, "delete");
  }

  if (!authResult.valid) {
    return { ok: false, error: authResult.error };
  }

  try {
    const repo = getEncryptedSecretRepository(env.DB);
    await repo.delete(authResult.result.workspaceId, request.key);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: `Failed to delete secret: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

// =============================================================================
// Main Handler
// =============================================================================

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    let kek: CryptoKey;
    try {
      kek = await loadKEK(env);
    } catch (error) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: `Failed to load KEK: ${error instanceof Error ? error.message : String(error)}`,
        }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    const url = new URL(request.url);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return new Response(
        JSON.stringify({ ok: false, error: "Invalid JSON body" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    let result: SecretResponse | ErrorResponse;

    switch (url.pathname) {
      case "/store":
        result = await handleStore(body as StoreSecretRequest, env, kek);
        break;
      case "/get":
        result = await handleGet(body as GetSecretRequest, env, kek);
        break;
      case "/delete":
        result = await handleDelete(body as DeleteSecretRequest, env);
        break;
      default:
        return new Response(
          JSON.stringify({ ok: false, error: "Unknown endpoint" }),
          { status: 404, headers: { "Content-Type": "application/json" } }
        );
    }

    return new Response(JSON.stringify(result), {
      status: result.ok ? 200 : 400,
      headers: { "Content-Type": "application/json" },
    });
  },
} satisfies ExportedHandler<Env>;
