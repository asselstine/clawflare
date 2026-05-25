// Auth Route Handlers - /v1/auth/*
// Handles device authorization flow and OAuth callbacks

import type { Env } from "../../internal-types/index.js";
import { json, badRequest, serverError } from "../responses.js";
import { getDataLayer } from "../../data/index.js";
import type { RequestContext } from "../request-context.js";

// GitHub OAuth configuration (from environment or defaults)
const GITHUB_OAUTH_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_API_URL = "https://api.github.com";

// Device authorization constants
const DEVICE_CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const POLL_INTERVAL_SECONDS = 2;

// Token prefix for generated access tokens
const TOKEN_PREFIX = "clf_";

/**
 * Generate a secure opaque access token
 * Format: clf_<base64url-encoded-random-bytes>
 */
function generateAccessToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const encoded = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `${TOKEN_PREFIX}${encoded}`;
}

/**
 * Sanitize client name for display
 */
function sanitizeClientName(name: unknown): string | null {
  if (typeof name !== "string") return null;
  const sanitized = name.trim().slice(0, 100);
  return sanitized.length > 0 ? sanitized : null;
}

/**
 * Device authorization initiation
 * Creates a device authorization request and returns a URL for the user to visit
 * POST /v1/auth/device/start
 */
export async function handleDeviceAuthStart(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const body = (await request.json()) as { clientName?: string };
    const clientName = sanitizeClientName(body.clientName) || "Unknown application";

    const clientId = env.GITHUB_CLIENT_ID;
    if (!clientId) {
      return serverError("GitHub OAuth not configured");
    }

    const now = Date.now();
    const expiresAt = now + DEVICE_CODE_TTL_MS;
    const deviceCode = crypto.randomUUID();

    // Store device authorization
    await env.DB.prepare(
      `
      INSERT INTO device_authorizations
        (device_code, client_name, created_at, expires_at)
      VALUES (?, ?, ?, ?)
    `
    )
      .bind(deviceCode, clientName, now, expiresAt)
      .run();

    // Build OAuth URL with device flow state
    const redirectUri = `${new URL(request.url).origin}/v1/auth/github/callback`;
    const state = JSON.stringify({
      flow: "device",
      deviceCode,
      clientName,
    });

    const authUrl = `${GITHUB_OAUTH_URL}?client_id=${clientId}&redirect_uri=${encodeURIComponent(
      redirectUri
    )}&scope=user:email&state=${encodeURIComponent(state)}`;

    return json({
      deviceCode,
      verificationUrl: authUrl,
      expiresAt,
      intervalSeconds: POLL_INTERVAL_SECONDS,
      message: `Visit the URL to authenticate ${clientName}`,
    });
  } catch (error) {
    console.error("[handleDeviceAuthStart] Error:", error);
    return serverError(error instanceof Error ? error.message : "Unknown error");
  }
}

/**
 * Device authorization poll
 * Polls for authorization completion
 * POST /v1/auth/device/poll
 */
export async function handleDeviceAuthPoll(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const body = (await request.json()) as { deviceCode: string };
    const { deviceCode } = body;

    if (!deviceCode) {
      return badRequest("deviceCode required");
    }

    // Check device authorization
    const row = await env.DB.prepare(
      `
      SELECT user_id, access_token_id, access_token_plaintext, completed_at, expires_at
      FROM device_authorizations
      WHERE device_code = ?
    `
    )
      .bind(deviceCode)
      .first<{
        user_id: string;
        access_token_id: string;
        access_token_plaintext: string;
        completed_at: number;
        expires_at: number;
      }>();

    if (!row) {
      return json({
        status: "pending",
        message: "Authorization pending",
      });
    }

    // Check expiration
    if (Date.now() > row.expires_at) {
      // Clean up expired device authorization
      await env.DB.prepare(
        `
        DELETE FROM device_authorizations WHERE device_code = ?
      `
      )
        .bind(deviceCode)
        .run();

      return json({
        status: "expired",
        message: "Device authorization expired",
      });
    }

    if (!row.completed_at) {
      return json({
        status: "pending",
        message: "Authorization pending",
      });
    }

    // Get user info
    const userRow = await env.DB.prepare(
      `
      SELECT id, email, display_name
      FROM users
      WHERE id = ?
    `
    )
      .bind(row.user_id)
      .first<{ id: string; email: string; display_name: string | null }>();

    // Clean up the device authorization after successful poll
    await env.DB.prepare(
      `
      DELETE FROM device_authorizations WHERE device_code = ?
    `
    )
      .bind(deviceCode)
      .run();

    return json({
      status: "complete",
      accessToken: row.access_token_plaintext,
      user: userRow
        ? {
            id: userRow.id,
            email: userRow.email,
            displayName: userRow.display_name ?? undefined,
          }
        : null,
    });
  } catch (error) {
    console.error("[handleDeviceAuthPoll] Error:", error);
    return serverError(error instanceof Error ? error.message : "Unknown error");
  }
}

/**
 * GitHub OAuth callback
 * Handles GitHub OAuth response and creates/updates user
 * GET/POST /v1/auth/github/callback
 */
export async function handleGithubCallback(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const url = new URL(request.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error");

    if (error) {
      return badRequest(`OAuth error: ${error}`);
    }

    if (!code || !state) {
      return badRequest("Missing code or state");
    }

    // Parse state to determine flow type
    let stateData: { flow?: string; type?: string; deviceCode?: string; clientName?: string };
    try {
      stateData = JSON.parse(state);
    } catch {
      return badRequest("Invalid state parameter");
    }

    // Support both new 'flow' and legacy 'type' for compatibility during transition
    const flowType = stateData.flow || stateData.type;

    // Exchange code for access token
    const clientId = env.GITHUB_CLIENT_ID;
    const clientSecret = env.GITHUB_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      return serverError("GitHub OAuth not configured");
    }

    const tokenResponse = await fetch(GITHUB_TOKEN_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code,
      }),
    });

    const tokenData = (await tokenResponse.json()) as {
      access_token?: string;
      error?: string;
    };

    if (tokenData.error || !tokenData.access_token) {
      return badRequest(`Token exchange failed: ${tokenData.error || "unknown error"}`);
    }

    const accessToken = tokenData.access_token;

    // Get user info from GitHub
    const userResponse = await fetch(`${GITHUB_API_URL}/user`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/vnd.github.v3+json",
      },
    });

    const githubUser = (await userResponse.json()) as {
      id: number;
      login: string;
      email: string | null;
      name: string | null;
    };

    // Get email if not public
    let email = githubUser.email;
    if (!email) {
      const emailsResponse = await fetch(`${GITHUB_API_URL}/user/emails`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/vnd.github.v3+json",
        },
      });
      const emails = (await emailsResponse.json()) as Array<{
        email: string;
        primary: boolean;
        verified: boolean;
      }>;
      const primaryEmail = emails.find((e) => e.primary && e.verified);
      if (primaryEmail) {
        email = primaryEmail.email;
      }
    }

    if (!email) {
      return badRequest("Could not retrieve email from GitHub");
    }

    // Create or update user
    const now = Date.now();
    const userId = crypto.randomUUID();

    // Check if user exists
    const existingUser = await env.DB.prepare(
      `
      SELECT id FROM users WHERE email = ?
    `
    )
      .bind(email)
      .first<{ id: string }>();

    let finalUserId: string;

    if (existingUser) {
      finalUserId = existingUser.id;
      // Update user info
      await env.DB.prepare(
        `
        UPDATE users
        SET display_name = ?, updated_at = ?
        WHERE id = ?
      `
      )
        .bind(githubUser.name || githubUser.login, now, finalUserId)
        .run();
    } else {
      finalUserId = userId;
      // Create new user
      await env.DB.prepare(
        `
        INSERT INTO users (id, email, display_name, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `
      )
        .bind(userId, email, githubUser.name || githubUser.login, now, now)
        .run();

      // Create OAuth account link
      await env.DB.prepare(
        `
        INSERT INTO oauth_accounts
        (id, user_id, provider, provider_account_id, access_token, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `
      )
        .bind(
          crypto.randomUUID(),
          userId,
          "github",
          String(githubUser.id),
          accessToken,
          now,
          now
        )
        .run();

      // Create personal workspace
      const data = getDataLayer(env);
      const workspaceId = crypto.randomUUID();
      const slug = `personal-${now.toString(36).slice(-6)}`;

      await data.workspaces.create({
        id: workspaceId,
        slug,
        name: "Personal Workspace",
        description: "Your personal workspace",
      });

      await data.workspaces.addMembership({
        workspaceId,
        userId,
        role: "owner",
      });
    }

    // Handle device authorization flow
    if (flowType === "device" && stateData.deviceCode) {
      // Generate access token
      const rawToken = generateAccessToken();
      const tokenHash = await hashToken(rawToken);
      const tokenId = crypto.randomUUID();

      // Get client name from device authorization record
      const deviceAuth = await env.DB.prepare(
        `
        SELECT client_name FROM device_authorizations WHERE device_code = ?
      `
      )
        .bind(stateData.deviceCode)
        .first<{ client_name: string }>();

      const clientName = deviceAuth?.client_name || stateData.clientName || "Unknown application";

      // Store access token (hashed)
      await env.DB.prepare(
        `
        INSERT INTO access_tokens (id, user_id, token_hash, name, client_name, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `
      )
        .bind(tokenId, finalUserId, tokenHash, "Access Token", clientName, now)
        .run();

      // Update device authorization with token info
      await env.DB.prepare(
        `
        UPDATE device_authorizations
        SET user_id = ?,
            access_token_id = ?,
            access_token_plaintext = ?,
            completed_at = ?
        WHERE device_code = ?
      `
      )
        .bind(finalUserId, tokenId, rawToken, now, stateData.deviceCode)
        .run();

      // Escape client name for HTML display
      const escapedClientName = clientName
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");

      // Return HTML that shows success message
      return new Response(
        `<!DOCTYPE html>
<html>
<head><title>Authentication Complete</title></head>
<body>
<h1>Authentication Complete</h1>
<p>You can now close this window and return to ${escapedClientName}.</p>
</body>
</html>`,
        { headers: { "Content-Type": "text/html" } }
      );
    }

    // Legacy CLI flow (for backward compatibility during transition)
    if (stateData.type === "cli" && stateData.deviceCode) {
      // Generate access token
      const rawToken = generateAccessToken();
      const tokenHash = await hashToken(rawToken);
      const tokenId = crypto.randomUUID();

      // Store access token
      await env.DB.prepare(
        `
        INSERT INTO access_tokens (id, user_id, token_hash, name, client_name, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `
      )
        .bind(tokenId, finalUserId, tokenHash, "Clawflare CLI", "Clawflare CLI", now)
        .run();

      // Update device authorization with token info
      await env.DB.prepare(
        `
        UPDATE device_authorizations
        SET user_id = ?,
            access_token_id = ?,
            access_token_plaintext = ?,
            completed_at = ?
        WHERE device_code = ?
      `
      )
        .bind(finalUserId, tokenId, rawToken, now, stateData.deviceCode)
        .run();

      // Return HTML that shows success message
      return new Response(
        `<!DOCTYPE html>
<html>
<head><title>Authentication Complete</title></head>
<body>
<h1>Authentication Complete</h1>
<p>You can now close this window and return to Clawflare CLI.</p>
</body>
</html>`,
        { headers: { "Content-Type": "text/html" } }
      );
    }

    // Web flow - return JSON success
    return json({
      success: true,
      message: "Authentication successful",
    });
  } catch (error) {
    console.error("[handleGithubCallback] Error:", error);
    return serverError(error instanceof Error ? error.message : "Unknown error");
  }
}

/**
 * Hash a token using SHA-256 for database storage
 */
async function hashToken(token: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(token);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Get current user info
 * GET /v1/me
 */
export async function handleGetMe(
  _request: Request,
  env: Env,
  ctx: RequestContext
): Promise<Response> {
  try {
    // Get user's workspaces
    const data = getDataLayer(env);
    const workspaces = await data.workspaces.listForUser(ctx.user.id);

    return json({
      user: {
        id: ctx.user.id,
        email: ctx.user.email,
        displayName: ctx.user.displayName,
        createdAt: ctx.user.createdAt,
      },
      workspaces: workspaces.map((w) => ({
        id: w.id,
        slug: w.slug,
        name: w.name,
        description: w.description,
        role: ctx.workspace.id === w.id ? ctx.role : undefined,
      })),
      currentWorkspace: {
        id: ctx.workspace.id,
        slug: ctx.workspace.slug,
        name: ctx.workspace.name,
        role: ctx.role,
      },
    });
  } catch (error) {
    console.error("[handleGetMe] Error:", error);
    return serverError(error instanceof Error ? error.message : "Unknown error");
  }
}

/**
 * Logout - revoke access token
 * POST /v1/auth/logout
 */
export async function handleLogout(
  _request: Request,
  env: Env,
  ctx: RequestContext
): Promise<Response> {
  try {
    // Revoke the current token
    if (ctx.accessTokenId) {
      const now = Date.now();
      await env.DB.prepare(
        `
        UPDATE access_tokens SET revoked_at = ? WHERE id = ?
      `
      )
        .bind(now, ctx.accessTokenId)
        .run();
    }

    return json({ success: true, message: "Logged out successfully" });
  } catch (error) {
    console.error("[handleLogout] Error:", error);
    return serverError(error instanceof Error ? error.message : "Unknown error");
  }
}