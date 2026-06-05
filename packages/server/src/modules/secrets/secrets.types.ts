/**
 * Secret Broker Types - Authorization Context
 */

/**
 * Authorization context passed from Main Worker to Secret Broker via Service Binding.
 * This is a DERIVED context - the Main Worker already validated the user's token
 * and extracts only what's needed for authorization.
 *
 * Service Binding Authentication:
 * - Cloudflare service bindings use mTLS between Workers
 * - The broker trusts that requests came from the Main Worker
 * - The broker validates the authorization context against D1
 */
export interface AuthorizationContext {
  /** User ID from authenticated session */
  userId: string;
  /** Workspace being accessed */
  workspaceId: string;
  /** Unix timestamp when authorization was granted */
  authTime: number;
  /** Request ID for tracing */
  requestId: string;
  /** Authorization version for compatibility */
  version: number;
}

/**
 * Secret Broker Request Types
 */
export interface StoreSecretRequest {
  /** Authorization context (not raw token) */
  auth: AuthorizationContext;
  /** Secret key */
  key: string;
  /** Secret value (plaintext - will be encrypted) */
  value: string;
}

export interface GetSecretRequest {
  /** Authorization context, session reference, or workspace-scoped service reference */
  auth: AuthorizationContext | { sessionId: string } | { workspaceId: string };
  /** Secret key */
  key: string;
}

export interface DeleteSecretRequest {
  /** Authorization context */
  auth: AuthorizationContext;
  /** Secret key */
  key: string;
}

export interface SecretResponse {
  ok: true;
  value?: string;
}

export interface ErrorResponse {
  ok: false;
  error: string;
}

/** Current authorization version */
export const AUTH_VERSION = 1;

/** Maximum authorization age (5 minutes for sync requests) */
export const MAX_AUTH_AGE_MS = 5 * 60 * 1000;

/**
 * Validate an authorization context
 */
export function validateAuthContext(auth: AuthorizationContext): { valid: true } | { valid: false; error: string } {
  if (auth.version !== AUTH_VERSION) {
    return { valid: false, error: `Invalid auth version: ${auth.version}` };
  }

  const age = Date.now() - auth.authTime;
  if (age > MAX_AUTH_AGE_MS) {
    return { valid: false, error: `Authorization expired (age: ${age}ms)` };
  }

  if (age < 0) {
    return { valid: false, error: "Authorization timestamp is in the future" };
  }

  if (!auth.userId || !auth.workspaceId) {
    return { valid: false, error: "Missing userId or workspaceId" };
  }

  return { valid: true };
}
