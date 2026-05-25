// Request Context - User and workspace authentication context for each request
// Provides multi-tenant authentication support for the Clawflare API

import type { Env } from "../internal-types/index.js";
import { getDataLayer } from "../data/index.js";
import type { User, Workspace, WorkspaceRole } from "../data/index.js";

/**
 * Request context containing authenticated user and workspace information
 * Every authenticated request must have a resolved context
 */
export interface RequestContext {
  /** Authenticated user (from CLI token or OAuth session) */
  user: User;

  /** Active workspace for this request */
  workspace: Workspace;

  /** User's role in the workspace */
  role: WorkspaceRole;

  /** CI token metadata if authenticated via token */
  tokenId?: string;

  /** OAuth provider if authenticated via web */
  oauthProvider?: string;
}

/**
 * Token verification result
 */
interface TokenVerificationResult {
  userId: string;
  tokenId: string;
}

/**
 * Extract bearer token from Authorization header
 * Returns null if no valid bearer token found
 */
export function getBearerToken(request: Request): string | null {
  const auth = request.headers.get("Authorization");
  if (!auth || !auth.startsWith("Bearer ")) {
    return null;
  }
  return auth.slice(7);
}

/**
 * Hash a token using SHA-256 for database lookup
 * CLI tokens are stored hashed in the database
 */
async function hashToken(token: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(token);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Verify a CLI token and return the user ID if valid
 * Also updates last_used_at timestamp
 */
async function verifyCliToken(
  token: string,
  env: Env
): Promise<TokenVerificationResult | null> {
  const data = getDataLayer(env);

  try {
    const tokenHash = await hashToken(token);
    const row = await env.DB.prepare(
      `
      SELECT id, user_id, expires_at
      FROM cli_tokens
      WHERE token_hash = ?
    `
    )
      .bind(tokenHash)
      .first<{ id: string; user_id: string; expires_at: number | null }>();

    if (!row) {
      return null;
    }

    // Check if token is expired
    if (row.expires_at && Date.now() > row.expires_at) {
      return null;
    }

    // Update last_used_at
    await env.DB.prepare(
      `
      UPDATE cli_tokens
      SET last_used_at = ?
      WHERE id = ?
    `
    )
      .bind(Date.now(), row.id)
      .run();

    return { userId: row.user_id, tokenId: row.id };
  } catch (error) {
    console.error("[verifyCliToken] Error:", error);
    return null;
  }
}

/**
 * Get default workspace for a user
 * Returns the first workspace they belong to, or creates a personal workspace
 */
async function getDefaultWorkspace(
  userId: string,
  env: Env
): Promise<Workspace | null> {
  try {
    const data = getDataLayer(env);
    const workspaces = await data.workspaces.listForUser(userId);

    if (workspaces.length > 0) {
      return workspaces[0];
    }

    // Create a personal workspace for the user
    const workspaceId = crypto.randomUUID();
    const now = Date.now();
    const slug = `personal-${now.toString(36).slice(-6)}`;

    const workspace = await data.workspaces.create({
      id: workspaceId,
      slug,
      name: "Personal Workspace",
      description: "Your default personal workspace",
    });

    // Add user as owner
    await data.workspaces.addMembership({
      workspaceId,
      userId,
      role: "owner",
    });

    return workspace;
  } catch (error) {
    console.error("[getDefaultWorkspace] Error:", error);
    return null;
  }
}

/**
 * Resolve request context from an authenticated request
 * Returns null if authentication fails
 */
export async function resolveRequestContext(
  token: string,
  env: Env
): Promise<RequestContext | null> {
  // Verify the token
  const tokenResult = await verifyCliToken(token, env);
  if (!tokenResult) {
    return null;
  }

  const data = getDataLayer(env);

  // Load user
  const userRow = await env.DB.prepare(
    `
    SELECT id, email, display_name, created_at, updated_at
    FROM users
    WHERE id = ?
  `
  )
    .bind(tokenResult.userId)
    .first<{ id: string; email: string; display_name: string | null; created_at: number; updated_at: number }>();

  if (!userRow) {
    return null;
  }

  const user: User = {
    id: userRow.id,
    email: userRow.email,
    displayName: userRow.display_name ?? undefined,
    createdAt: userRow.created_at,
    updatedAt: userRow.updated_at,
  };

  // Get default workspace
  const workspace = await getDefaultWorkspace(user.id, env);
  if (!workspace) {
    return null;
  }

  // Get user's role in workspace
  const role = await data.workspaces.getUserRole(workspace.id, user.id);
  if (!role) {
    return null;
  }

  return {
    user,
    workspace,
    role,
    tokenId: tokenResult.tokenId,
  };
}

/**
 * Check if request context has required permission level
 */
export function hasPermission(
  ctx: RequestContext,
  requiredRole: WorkspaceRole
): boolean {
  const roleHierarchy: WorkspaceRole[] = ["viewer", "member", "admin", "owner"];
  const userLevel = roleHierarchy.indexOf(ctx.role);
  const requiredLevel = roleHierarchy.indexOf(requiredRole);
  return userLevel >= requiredLevel;
}
