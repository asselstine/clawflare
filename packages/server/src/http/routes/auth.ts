// Auth Route Handlers - /v1/auth/*
// Handles CLI authentication flow and OAuth callbacks

import type { Env } from "../../internal-types/index.js";
import { json, badRequest, unauthorized, serverError } from "../responses.js";
import { getDataLayer } from "../../data/index.js";
import type { RequestContext } from "../request-context.js";

// GitHub OAuth configuration (from environment or defaults)
const GITHUB_OAUTH_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_API_URL = "https://api.github.com";

/**
 * CLI login initiation
 * Creates a device authorization request and returns a URL for the user to visit
 * POST /v1/auth/cli/start
 */
export async function handleCliLoginStart(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const body = (await request.json()) as { deviceCode?: string };
    const deviceCode = body.deviceCode || crypto.randomUUID();

    // In Phase 7, we implement a simplified flow:
    // 1. CLI generates a verification code
    // 2. User visits /v1/auth/cli/verify with the code
    // 3. After GitHub OAuth, the CLI token is associated with the code
    // 4. CLI polls /v1/auth/cli/poll to retrieve the token

    // For now, return a direct GitHub OAuth URL
    // The user_code will be the device code for polling
    const clientId = env.GITHUB_CLIENT_ID;
    if (!clientId) {
      return serverError("GitHub OAuth not configured");
    }

    const redirectUri = `${new URL(request.url).origin}/v1/auth/github/callback`;
    const state = JSON.stringify({ type: "cli", deviceCode });

    const authUrl = `${GITHUB_OAUTH_URL}?client_id=${clientId}&redirect_uri=${encodeURIComponent(
      redirectUri
    )}&scope=user:email&state=${encodeURIComponent(state)}`;

    return json({
      deviceCode,
      verificationUrl: authUrl,
      message: "Visit the URL to authenticate with GitHub",
    });
  } catch (error) {
    console.error("[handleCliLoginStart] Error:", error);
    return serverError(error instanceof Error ? error.message : "Unknown error");
  }
}

/**
 * CLI token poll
 * Polls for authentication completion
 * POST /v1/auth/cli/poll
 */
export async function handleCliLoginPoll(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const body = (await request.json()) as { deviceCode: string };
    const { deviceCode } = body;

    if (!deviceCode) {
      return badRequest("deviceCode required");
    }

    // Check if there's a completed OAuth for this device code
    const row = await env.DB.prepare(
      `
      SELECT cli_token, user_id, completed_at
      FROM cli_device_authorizations
      WHERE device_code = ?
    `
    )
      .bind(deviceCode)
      .first<{ cli_token: string; user_id: string; completed_at: number }>();

    if (!row) {
      // Still pending
      return json({
        status: "pending",
        message: "Authorization pending",
      });
    }

    if (!row.completed_at) {
      // Still pending
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

    // Clean up the device authorization
    await env.DB.prepare(
      `
      DELETE FROM cli_device_authorizations
      WHERE device_code = ?
    `
    )
      .bind(deviceCode)
      .run();

    return json({
      status: "complete",
      token: row.cli_token,
      user: userRow
        ? {
            id: userRow.id,
            email: userRow.email,
            displayName: userRow.display_name ?? undefined,
          }
        : null,
    });
  } catch (error) {
    console.error("[handleCliLoginPoll] Error:", error);
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
    let stateData: { type: string; deviceCode?: string };
    try {
      stateData = JSON.parse(state);
    } catch {
      return badRequest("Invalid state parameter");
    }

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

    // Handle CLI flow
    if (stateData.type === "cli" && stateData.deviceCode) {
      // Generate CLI token
      const cliToken = crypto.randomUUID();
      const tokenHash = await hashToken(cliToken);

      await env.DB.prepare(
        `
        INSERT INTO cli_tokens (id, user_id, token_hash, name, created_at)
        VALUES (?, ?, ?, ?, ?)
      `
      )
        .bind(crypto.randomUUID(), finalUserId, tokenHash, "CLI", now)
        .run();

      // Store in device authorizations table
      await env.DB.prepare(
        `
        INSERT INTO cli_device_authorizations
        (device_code, user_id, cli_token, completed_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(device_code) DO UPDATE SET
          user_id = excluded.user_id,
          cli_token = excluded.cli_token,
          completed_at = excluded.completed_at
      `
      )
        .bind(stateData.deviceCode, finalUserId, cliToken, now)
        .run();

      // Return HTML that shows success message
      return new Response(
        `<!DOCTYPE html>
<html>
<head><title>Authentication Complete</title></head>
<body>
<h1>Authentication Complete</h1>
<p>You can now close this window and return to the CLI.</p>
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
  request: Request,
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
 * Logout - revoke CLI token
 * POST /v1/auth/logout
 */
export async function handleLogout(
  request: Request,
  env: Env,
  ctx: RequestContext
): Promise<Response> {
  try {
    // Revoke the current token
    if (ctx.tokenId) {
      await env.DB.prepare(
        `
        DELETE FROM cli_tokens WHERE id = ?
      `
      )
        .bind(ctx.tokenId)
        .run();
    }

    return json({ success: true, message: "Logged out successfully" });
  } catch (error) {
    console.error("[handleLogout] Error:", error);
    return serverError(error instanceof Error ? error.message : "Unknown error");
  }
}
