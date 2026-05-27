/**
 * Secret Broker Types - Authorization Context and Job Snapshots
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
 * Job Authorization Snapshot for async operations (workflows).
 * Stored in D1 when a job is created, referenced when job runs.
 */
export interface JobAuthorizationSnapshot {
  /** Job ID */
  jobId: string;
  /** User who created the job */
  createdByUserId: string;
  /** Workspace for the job */
  workspaceId: string;
  /** What operations this job is authorized for */
  allowedOperations: string[];
  /** Unix timestamp when job was created */
  createdAt: number;
  /** Unix timestamp when job authorization expires */
  expiresAt: number;
  /** Authorization version */
  authorizationVersion: number;
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
  /** Authorization context or Job Snapshot reference */
  auth: AuthorizationContext | { jobId: string };
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

/** Default job authorization expiry (1 hour) */
export const DEFAULT_JOB_EXPIRY_MS = 60 * 60 * 1000;

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

/**
 * Validate a job authorization snapshot
 */
export function validateJobSnapshot(snapshot: JobAuthorizationSnapshot): { valid: true } | { valid: false; error: string } {
  if (snapshot.authorizationVersion !== AUTH_VERSION) {
    return { valid: false, error: `Invalid job auth version: ${snapshot.authorizationVersion}` };
  }

  if (Date.now() > snapshot.expiresAt) {
    return { valid: false, error: "Job authorization expired" };
  }

  if (!snapshot.createdByUserId || !snapshot.workspaceId) {
    return { valid: false, error: "Missing userId or workspaceId in job snapshot" };
  }

  return { valid: true };
}
