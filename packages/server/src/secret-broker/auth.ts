/**
 * Secret Broker Authentication
 * Validates authorization context and workspace permissions
 */

import type { Env } from "../internal-types/index.js";
import {
  type AuthorizationContext,
  validateAuthContext,
  validateJobSnapshot,
} from "./types.js";
import { getJobSnapshotRepository } from "./job-snapshot.js";

export interface VerifiedAuth {
  userId: string;
  workspaceId: string;
  isJobAuth: boolean;
}

/**
 * Verify user has workspace membership
 */
async function verifyWorkspaceAccess(
  env: Env,
  userId: string,
  workspaceId: string
): Promise<boolean> {
  try {
    const row = await env.DB.prepare(
      `
      SELECT role
      FROM workspace_memberships
      WHERE workspace_id = ? AND user_id = ?
    `
    )
      .bind(workspaceId, userId)
      .first<{ role: string }>();

    return row !== null;
  } catch {
    return false;
  }
}

/**
 * Verify workspace and model connection exist
 */
async function verifyWorkspaceExists(
  env: Env,
  workspaceId: string
): Promise<boolean> {
  try {
    const row = await env.DB.prepare(
      `
      SELECT id
      FROM workspaces
      WHERE id = ?
    `
    )
      .bind(workspaceId)
      .first<{ id: string }>();

    return row !== null;
  } catch {
    return false;
  }
}

/**
 * Validate authorization and verify workspace access.
 * Called by the Secret Broker to ensure the caller is authorized.
 */
export async function validateAuthorization(
  env: Env,
  auth: AuthorizationContext
): Promise<{ valid: true; result: VerifiedAuth } | { valid: false; error: string }> {
  // Validate auth context format
  const validation = validateAuthContext(auth);
  if (!validation.valid) {
    return { valid: false, error: validation.error };
  }

  // Verify workspace exists
  const workspaceExists = await verifyWorkspaceExists(env, auth.workspaceId);
  if (!workspaceExists) {
    return { valid: false, error: "Workspace not found" };
  }

  // Verify user has workspace access
  const hasAccess = await verifyWorkspaceAccess(env, auth.userId, auth.workspaceId);
  if (!hasAccess) {
    return { valid: false, error: "User does not have access to workspace" };
  }

  return {
    valid: true,
    result: {
      userId: auth.userId,
      workspaceId: auth.workspaceId,
      isJobAuth: false,
    },
  };
}

/**
 * Validate job authorization snapshot.
 * Called by the Secret Broker for async operations (workflows).
 */
export async function validateJobAuthorization(
  env: Env,
  jobId: string,
  requiredOperation?: string
): Promise<{ valid: true; result: VerifiedAuth } | { valid: false; error: string }> {
  // Load snapshot
  const repo = getJobSnapshotRepository(env.DB);
  const snapshot = await repo.get(jobId);

  if (!snapshot) {
    return { valid: false, error: "Job authorization not found" };
  }

  // Validate snapshot format
  const validation = validateJobSnapshot(snapshot);
  if (!validation.valid) {
    return { valid: false, error: validation.error };
  }

  // Check operation permission
  if (requiredOperation && !snapshot.allowedOperations.includes(requiredOperation)) {
    return { valid: false, error: `Operation not allowed: ${requiredOperation}` };
  }

  // Verify workspace still exists
  const workspaceExists = await verifyWorkspaceExists(env, snapshot.workspaceId);
  if (!workspaceExists) {
    return { valid: false, error: "Workspace no longer exists" };
  }

  return {
    valid: true,
    result: {
      userId: snapshot.createdByUserId,
      workspaceId: snapshot.workspaceId,
      isJobAuth: true,
    },
  };
}
