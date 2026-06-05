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
 * For Workflows:
 * 1. Workflow references its sessionId when reading model secrets
 * 2. Broker validates the session exists and is still usable
 * 3. Broker checks workspace still exists
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
} from "./secrets.crypto.js";
import { validateAuthorization, validateSessionAuthorization, validateWorkspaceAuthorization } from "./secrets.auth.js";
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
 * Load the KEK from a Worker secret or Secrets Store secret binding.
 *
 * Cloudflare binds individual secret values to Workers; it does not expose a
 * mutable store object to Worker code. The KEK must be provisioned before the
 * Worker starts, while per-user/provider secrets are envelope-encrypted into D1.
 */
async function loadKEK(env: Env): Promise<CryptoKey> {
  const binding = env.CLAWFLARE_KEK;
  if (!binding) {
    throw new Error("CLAWFLARE_KEK secret binding not configured");
  }

  const kekBase64 = typeof binding === "string" ? binding : await binding.get();
  if (!kekBase64) {
    throw new Error(`${KEK_SECRET_NAME} secret binding is empty`);
  }

  return importKEK(decodeBase64(kekBase64));
}

// =============================================================================
// Request Handlers
// =============================================================================

/**
 * Parse authorization from request.
 * Can be AuthorizationContext or session reference.
 */
function parseAuth(
  auth: unknown
): { type: "context"; context: AuthorizationContext } | { type: "session"; sessionId: string } | { type: "workspace"; workspaceId: string } | null {
  if (!auth || typeof auth !== "object") return null;

  const a = auth as Record<string, unknown>;

  // Session reference: { sessionId: string }
  if ("sessionId" in a && typeof a.sessionId === "string") {
    return { type: "session", sessionId: a.sessionId };
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

  // Workspace-scoped service reference: { workspaceId: string }
  if ("workspaceId" in a && typeof a.workspaceId === "string") {
    return { type: "workspace", workspaceId: a.workspaceId };
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

  if (parsedAuth.type !== "context") {
    return { ok: false, error: "Session authorization cannot store secrets" };
  }

  const authResult = await validateAuthorization(env, parsedAuth.context);

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
  } else if (parsedAuth.type === "session") {
    authResult = await validateSessionAuthorization(env, parsedAuth.sessionId);
  } else {
    authResult = await validateWorkspaceAuthorization(env, parsedAuth.workspaceId);
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

  if (parsedAuth.type !== "context") {
    return { ok: false, error: "Session authorization cannot delete secrets" };
  }

  const authResult = await validateAuthorization(env, parsedAuth.context);

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
