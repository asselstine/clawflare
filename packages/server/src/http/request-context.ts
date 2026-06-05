// Request Context - User and workspace authentication context for each request
// Provides multi-tenant authentication support for the Clawflare API

import type { Env } from "../internal-types/index.js";
import {
  AuthContextRepository,
  UserRepository,
  WorkspaceRepository,
  type User,
  type Workspace,
  type WorkspaceRole,
} from "../data/index.js";
import { hashToken } from "../modules/auth/access-tokens.js";
import { verifyWebSession, extractSessionToken } from "../modules/auth/sessions.js";
import { logger } from "../lib/logger.js";
import { logTiming, timingStart } from "../lib/timing.js";

/**
 * Request context containing authenticated user and workspace information
 * Every authenticated request must have a resolved context
 */
export interface RequestContext {
  /** Authenticated user (from access token or web session) */
  user: User;

  /** Active workspace for this request */
  workspace: Workspace;

  /** User's role in the workspace */
  role: WorkspaceRole;

  /** Access token ID if authenticated via bearer token */
  accessTokenId?: string;

  /** Web session ID if authenticated via session cookie */
  sessionId?: string;

  /** CSRF token validator function (for session-based auth) */
  csrfTokenValid?: (token: string) => Promise<boolean>;
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
 * Get default workspace for a user
 * Returns the first workspace they belong to, or creates a personal workspace
 */
async function getDefaultWorkspace(
  userId: string,
  env: Env
): Promise<Workspace | null> {
  try {
    const workspacesRepo = new WorkspaceRepository(env.DB);
    const workspaces = await workspacesRepo.listForUser(userId);

    if (workspaces.length > 0) {
      return workspaces[0]!;
    }

    // Create a personal workspace for the user
    const workspaceId = crypto.randomUUID();
    const now = Date.now();
    const slug = `personal-${now.toString(36).slice(-6)}`;

    const workspace = await workspacesRepo.create({
      id: workspaceId,
      slug,
      name: "Personal Workspace",
      description: "Your default personal workspace",
    });

    // Add user as owner
    await workspacesRepo.addMembership({
      workspaceId,
      userId,
      role: "owner",
    });

    return workspace;
  } catch (error) {
    logger.error("Get default workspace failed", error, {
      function: "getDefaultWorkspace",
      userId,
    });
    return null;
  }
}

/**
 * Load user from database
 */
async function loadUser(
  userId: string,
  env: Env
): Promise<User | null> {
  try {
    const users = new UserRepository(env.DB);
    return await users.getById(userId);
  } catch (error) {
    logger.error("Load user failed", error, {
      function: "loadUser",
      userId,
    });
    return null;
  }
}

/**
 * Resolve request context from bearer token
 */
async function resolveBearerTokenContext(
  token: string,
  env: Env
): Promise<RequestContext | null> {
  const hashStart = timingStart();
  const tokenHash = await hashToken(token);
  logTiming(env, undefined, "auth.bearer.token_hashed", hashStart);

  const authContexts = new AuthContextRepository(env.DB);
  const resolveStart = timingStart();
  const resolved = await authContexts.resolveBearerToken(tokenHash);
  logTiming(env, undefined, "auth.bearer.context_query", resolveStart, {
    found: Boolean(resolved),
  });
  if (!resolved) return null;

  return {
    user: resolved.user,
    workspace: resolved.workspace,
    role: resolved.role,
    accessTokenId: resolved.accessTokenId,
  };
}

/**
 * Resolve request context from an authenticated request
 * Tries bearer token first, then falls back to session cookie
 * Returns null if authentication fails
 */
export async function resolveRequestContext(
  request: Request,
  env: Env
): Promise<RequestContext | null> {
  // Try bearer token
  const bearerToken = getBearerToken(request);
  if (bearerToken) {
    const ctx = await resolveBearerTokenContext(bearerToken, env);
    if (ctx) return ctx;
  }

  // Fall back to session cookie
  const sessionToken = extractSessionToken(request);
  if (sessionToken) {
    const sessionResult = await verifyWebSession(env, sessionToken);
    if (sessionResult) {
      const user = await loadUser(sessionResult.userId, env);
      if (user) {
        const workspace = await getDefaultWorkspace(user.id, env);
        if (workspace) {
          const workspaces = new WorkspaceRepository(env.DB);
          const role = await workspaces.getUserRole(workspace.id, user.id);
          if (role) {
            return {
              user,
              workspace,
              role,
              sessionId: sessionResult.sessionId,
              csrfTokenValid: sessionResult.csrfTokenValid,
            };
          }
        }
      }
    }
  }

  return null;
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

/**
 * Check if request has valid CSRF token (for session-based requests)
 */
export async function validateCsrfToken(
  request: Request,
  ctx: RequestContext
): Promise<boolean> {
  if (!ctx.csrfTokenValid) return true; // Bearer token auth doesn't need CSRF
  
  const csrfToken = request.headers.get("X-CSRF-Token");
  if (!csrfToken) return false;
  
  return await ctx.csrfTokenValid(csrfToken);
}
