// Auth Route Handlers - /v1/auth/*
// Native email/password + OAuth + device authorization

import type { Env } from "../../internal-types/index.js";
import { json, badRequest, serverError } from "../responses.js";
import { getDataLayer } from "../../data/index.js";
import type { RequestContext } from "../request-context.js";
import {
  hashPassword,
  verifyPassword,
  validatePasswordStrength,
  normalizeEmail,
  createAccessToken,
  createWebSession,
  createDeviceAuthorization,
  getDeviceAuthorizationByUserCode,
  denyDeviceAuthorization,
  pollDeviceAuthorization,
  getSessionCookie,
  getClearSessionCookie,
  createEmailVerificationToken,
  verifyEmailToken,
  createPasswordResetToken,
  verifyPasswordResetToken,
  consumePasswordResetToken,
} from "../../auth/index.js";

// GitHub OAuth configuration
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_API_URL = "https://api.github.com";

const POLL_INTERVAL_SECONDS = 2;

// Email validation regex (basic)
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Sanitize client name for display
function sanitizeClientName(name: unknown): string {
  if (typeof name !== "string") return "Unknown application";
  const sanitized = name.trim().slice(0, 100);
  return sanitized.length > 0 ? sanitized : "Unknown application";
}

// Escape HTML for safe display
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// =============================================================================
// Native Auth: Registration
// =============================================================================

/**
 * POST /v1/auth/register
 * Register new user with email/password
 */
export async function handleRegister(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const body = await request.json() as {
      email?: string;
      password?: string;
      displayName?: string;
    };

    const email = body.email?.trim().toLowerCase();
    const password = body.password;
    const displayName = body.displayName?.trim();

    if (!email || !EMAIL_REGEX.test(email)) {
      return badRequest("Invalid email address");
    }

    if (!password) {
      return badRequest("Password is required");
    }

    // Validate password strength
    const strength = validatePasswordStrength(password);
    if (!strength.valid) {
      return badRequest(strength.errors.join(", "));
    }

    const normalizedEmail = normalizeEmail(email);
    const now = Date.now();

    // Check if user already exists
    const existing = await env.DB.prepare(
      `SELECT id FROM users WHERE email = ?`
    ).bind(normalizedEmail).first<{ id: string }>();

    if (existing) {
      // Don't reveal if email exists - generic error
      return badRequest("Invalid email or password");
    }

    // Create user
    const userId = crypto.randomUUID();
    await env.DB.prepare(
      `
      INSERT INTO users (id, email, display_name, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `
    )
      .bind(userId, normalizedEmail, displayName ?? null, now, now)
      .run();

    // Store password hash
    const passwordHash = await hashPassword(password);
    await env.DB.prepare(
      `
      INSERT INTO password_credentials (user_id, password_hash, password_updated_at)
      VALUES (?, ?, ?)
    `
    )
      .bind(userId, passwordHash, now)
      .run();

    // Create personal workspace
    const data = getDataLayer(env);
    const workspaceId = crypto.randomUUID();
    const slug = `personal-${now.toString(36).slice(-6)}`;

    await data.workspaces.create({
      id: workspaceId,
      slug,
      name: displayName ? `${displayName}'s Workspace` : "Personal Workspace",
      description: "Your personal workspace",
    });

    await data.workspaces.addMembership({
      workspaceId,
      userId,
      role: "owner",
    });

    // Create email verification token (async - don't block response)
    const verificationToken = await createEmailVerificationToken(env, userId);
    // TODO: Send actual email with verification link
    console.log(`[Email Verification] Token for ${normalizedEmail}: ${verificationToken}`);

    // Create web session
    const sessionResult = await createWebSession(env, userId);
    if (!sessionResult) {
      return serverError("Failed to create session");
    }

    // Set session cookie
    const cookie = getSessionCookie(sessionResult.sessionToken, sessionResult.expiresAt);
    const user = await env.DB.prepare(
      `SELECT id, email, display_name, created_at FROM users WHERE id = ?`
    ).bind(userId).first<{
      id: string;
      email: string;
      display_name: string | null;
      created_at: number;
    }>();

    const workspaces = await data.workspaces.listForUser(userId);

    return json({
      user: {
        id: user!.id,
        email: user!.email,
        displayName: user!.display_name ?? undefined,
        createdAt: user!.created_at,
        emailVerified: false,
      },
      workspaces: workspaces.map((w) => ({
        id: w.id,
        slug: w.slug,
        name: w.name,
        role: "owner" as const,
      })),
      csrfToken: sessionResult.csrfToken,
    }, {
      headers: { "Set-Cookie": cookie },
    });
  } catch (error) {
    console.error("[handleRegister] Error:", error);
    return serverError(error instanceof Error ? error.message : "Unknown error");
  }
}

/**
 * POST /v1/auth/login
 * Login with email/password
 */
export async function handleLogin(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const body = await request.json() as {
      email?: string;
      password?: string;
    };

    const email = body.email?.trim().toLowerCase();
    const password = body.password;

    if (!email || !password) {
      // Generic error - don't reveal which field is wrong
      return badRequest("Invalid email or password");
    }

    const normalizedEmail = normalizeEmail(email);

    // Load user with password credential
    const userRow = await env.DB.prepare(
      `
      SELECT u.id, u.email, u.display_name, u.created_at, u.updated_at,
             pc.password_hash
      FROM users u
      LEFT JOIN password_credentials pc ON u.id = pc.user_id
      WHERE u.email = ?
    `
    )
      .bind(normalizedEmail)
      .first<{
        id: string;
        email: string;
        display_name: string | null;
        created_at: number;
        updated_at: number;
        password_hash: string | null;
      }>();

    // Generic error - don't reveal if user exists
    if (!userRow || !userRow.password_hash) {
      return badRequest("Invalid email or password");
    }

    // Verify password
    const passwordValid = await verifyPassword(password, userRow.password_hash);
    if (!passwordValid) {
      return badRequest("Invalid email or password");
    }

    // Create web session
    const sessionResult = await createWebSession(env, userRow.id);
    if (!sessionResult) {
      return serverError("Failed to create session");
    }

    const cookie = getSessionCookie(sessionResult.sessionToken, sessionResult.expiresAt);

    const data = getDataLayer(env);
    const workspaces = await data.workspaces.listForUser(userRow.id);

    return json({
      user: {
        id: userRow.id,
        email: userRow.email,
        displayName: userRow.display_name ?? undefined,
        createdAt: userRow.created_at,
      },
      workspaces: workspaces.map((w) => ({
        id: w.id,
        slug: w.slug,
        name: w.name,
        role: "owner",
      })),
      csrfToken: sessionResult.csrfToken,
    }, {
      headers: { "Set-Cookie": cookie },
    });
  } catch (error) {
    console.error("[handleLogin] Error:", error);
    return serverError(error instanceof Error ? error.message : "Unknown error");
  }
}

// =============================================================================
// Device Authorization Flow
// =============================================================================

/**
 * POST /v1/auth/device/start
 * Start device authorization
 */
export async function handleDeviceAuthStart(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const body = await request.json() as { clientName?: string };
    const clientName = sanitizeClientName(body.clientName);

    const result = await createDeviceAuthorization(env, clientName);
    if (!result) {
      return serverError("Failed to create device authorization");
    }

    const verificationUrl = `${new URL(request.url).origin}/v1/auth/device/verify?code=${result.userCode}`;

    return json({
      deviceCode: result.deviceCode,
      userCode: result.userCode,
      verificationUrl,
      expiresIn: 600, // 10 minutes in seconds
      interval: POLL_INTERVAL_SECONDS,
    });
  } catch (error) {
    console.error("[handleDeviceAuthStart] Error:", error);
    return serverError(error instanceof Error ? error.message : "Unknown error");
  }
}

/**
 * GET /v1/auth/device/verify
 * Browser page to verify/approve device
 */
export async function handleDeviceVerify(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const url = new URL(request.url);
    const userCode = url.searchParams.get("code")?.toUpperCase().replace(/[^A-Z0-9]/g, "");

    if (!userCode) {
      return new Response(
        `<!DOCTYPE html>
<html>
<head><title>Device Authorization</title></head>
<body>
<h1>Invalid Code</h1>
<p>Please provide a valid device code.</p>
</body>
</html>`,
        { headers: { "Content-Type": "text/html" }, status: 400 }
      );
    }

    const deviceAuth = await getDeviceAuthorizationByUserCode(env, userCode);
    if (!deviceAuth) {
      return new Response(
        `<!DOCTYPE html>
<html>
<head><title>Device Authorization</title></head>
<body>
<h1>Device Not Found</h1>
<p>This device code is invalid or has expired.</p>
</body>
</html>`,
        { headers: { "Content-Type": "text/html" }, status: 404 }
      );
    }

    if (deviceAuth.status !== "pending") {
      return new Response(
        `<!DOCTYPE html>
<html>
<head><title>Device Authorization</title></head>
<body>
<h1>Already Processed</h1>
<p>This device authorization has already been ${deviceAuth.status}.</p>
</body>
</html>`,
        { headers: { "Content-Type": "text/html" } }
      );
    }

    if (Date.now() > deviceAuth.expiresAt) {
      return new Response(
        `<!DOCTYPE html>
<html>
<head><title>Device Authorization</title></head>
<body>
<h1>Code Expired</h1>
<p>This device code has expired. Please try again.</p>
</body>
</html>`,
        { headers: { "Content-Type": "text/html" }, status: 410 }
      );
    }

    // Return approval form
    return new Response(
      `<!DOCTYPE html>
<html>
<head>
<title>Authorize Device</title>
<style>
body { font-family: system-ui, sans-serif; max-width: 500px; margin: 50px auto; padding: 20px; }
h1 { color: #333; }
.device-name { font-weight: bold; background: #f0f0f0; padding: 4px 8px; border-radius: 4px; }
.buttons { display: flex; gap: 10px; margin-top: 20px; }
button { padding: 10px 20px; border: none; border-radius: 4px; cursor: pointer; font-size: 16px; }
.approve { background: #4CAF50; color: white; }
.deny { background: #f44336; color: white; }
.deny:hover { background: #d32f2f; }
.approve:hover { background: #45a045; }
</style>
</head>
<body>
<h1>Authorize Device</h1>
<p><span class="device-name">${escapeHtml(deviceAuth.clientName)}</span> is requesting access to your Clawflare account.</p>
<p>Do you want to allow this?</p>
<form method="POST" action="/v1/auth/device/approve">
<input type="hidden" name="code" value="${escapeHtml(userCode)}" />
<div class="buttons">
<button type="submit" name="action" value="approve" class="approve">Approve</button>
<button type="submit" name="action" value="deny" class="deny">Deny</button>
</div>
</form>
</body>
</html>`,
      { headers: { "Content-Type": "text/html" } }
    );
  } catch (error) {
    console.error("[handleDeviceVerify] Error:", error);
    return serverError(error instanceof Error ? error.message : "Unknown error");
  }
}

/**
 * POST /v1/auth/device/approve
 * Approve or deny device authorization
 */
export async function handleDeviceApprove(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const formData = await request.formData();
    const userCode = formData.get("code")?.toString().toUpperCase().replace(/[^A-Z0-9]/g, "");
    const action = formData.get("action")?.toString();

    if (!userCode) {
      return new Response("Invalid code", { status: 400 });
    }

    // Get user from web session (TODO: properly implement session check)
    // For now, require session cookie
    // This is simplified - in production, check CSRF token and session
    const cookieSessionToken = request.headers.get("Cookie")
      ?.match(/clawflare_session=([^;]+)/)?.[1];
    
    if (!cookieSessionToken) {
      return new Response(
        `<!DOCTYPE html>
<html>
<head><title>Sign In Required</title></head>
<body>
<h1>Sign In Required</h1>
<p>Please <a href="/login">sign in</a> to authorize this device.</p>
</body>
</html>`,
        { headers: { "Content-Type": "text/html" }, status: 401 }
      );
    }

    // TODO: Actually verify session and get user ID
    // For now, this is a placeholder that looks up the device auth
    const deviceAuth = await env.DB.prepare(
      `SELECT device_code FROM device_authorizations WHERE user_code = ?`
    ).bind(userCode).first<{ device_code: string }>();

    if (!deviceAuth) {
      return new Response("Device not found", { status: 404 });
    }

    // Get user from session (simplified)
    // In full implementation, verify web session first
    // const session = await verifyWebSession(env, cookieSessionToken);
    // if (!session) return unauthorized
    // const userId = session.userId;

    if (action === "deny") {
      await denyDeviceAuthorization(env, deviceAuth.device_code);
      return new Response(
        `<!DOCTYPE html>
<html>
<head><title>Access Denied</title></head>
<body>
<h1>Access Denied</h1>
<p>You have denied access to this device. You can close this window.</p>
</body>
</html>`,
        { headers: { "Content-Type": "text/html" } }
      );
    }

    // Approve - but we need user ID from session
    // This is simplified - full implementation needs proper session handling
    return new Response(
      `<!DOCTYPE html>
<html>
<head><title>Session Required</title></head>
<body>
<h1>Session Management</h1>
<p>Device approval requires a valid web session. Please sign in first.</p>
<p>Note: This endpoint should check the session cookie and approve on behalf of the logged-in user.</p>
</body>
</html>`,
      { headers: { "Content-Type": "text/html" } }
    );
  } catch (error) {
    console.error("[handleDeviceApprove] Error:", error);
    return serverError(error instanceof Error ? error.message : "Unknown error");
  }
}

/**
 * POST /v1/auth/device/poll
 * Poll for device authorization completion
 */
export async function handleDeviceAuthPoll(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const body = await request.json() as { deviceCode?: string };
    const deviceCode = body.deviceCode;

    if (!deviceCode) {
      return badRequest("deviceCode is required");
    }

    const result = await pollDeviceAuthorization(env, deviceCode);
    if (!result) {
      return badRequest("Invalid device code");
    }

    if (result.status === "expired") {
      return json({ status: "expired", message: "Device code expired" });
    }

    if (result.status === "denied") {
      return json({ status: "denied", message: "Device authorization denied" });
    }

    if (result.status === "pending") {
      return json({ status: "pending" });
    }

    // Complete - get user info if available
    if (result.userId) {
      const userRow = await env.DB.prepare(
        `SELECT id, email, display_name FROM users WHERE id = ?`
      ).bind(result.userId).first<{
        id: string;
        email: string;
        display_name: string | null;
      }>();

      if (userRow) {
        return json({
          status: "complete",
          user: {
            id: userRow.id,
            email: userRow.email,
            displayName: userRow.display_name ?? undefined,
          },
        });
      }
    }

    return json({ status: "complete" });
  } catch (error) {
    console.error("[handleDeviceAuthPoll] Error:", error);
    return serverError(error instanceof Error ? error.message : "Unknown error");
  }
}

// =============================================================================
// GitHub OAuth
// =============================================================================

/**
 * GET /v1/auth/github/callback
 * GitHub OAuth callback
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

    // Parse state
    let stateData: { flow?: string; deviceCode?: string; clientName?: string };
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

    const githubAccessToken = tokenData.access_token;

    // Get user info from GitHub
    const userResponse = await fetch(`${GITHUB_API_URL}/user`, {
      headers: {
        Authorization: `Bearer ${githubAccessToken}`,
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
          Authorization: `Bearer ${githubAccessToken}`,
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

    const now = Date.now();
    const normalizedEmail = normalizeEmail(email);

    // Check if user exists
    const existingUser = await env.DB.prepare(
      `SELECT id FROM users WHERE email = ?`
    ).bind(normalizedEmail).first<{ id: string }>();

    let userId: string;

    if (existingUser) {
      userId = existingUser.id;
      // Update user info
      await env.DB.prepare(
        `UPDATE users SET display_name = ?, updated_at = ? WHERE id = ?`
      )
        .bind(githubUser.name || githubUser.login, now, userId)
        .run();
    } else {
      // Create new user
      userId = crypto.randomUUID();
      await env.DB.prepare(
        `
        INSERT INTO users (id, email, display_name, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `
      )
        .bind(userId, normalizedEmail, githubUser.name || githubUser.login, now, now)
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
    if (stateData.flow === "device" && stateData.deviceCode) {
      const clientName = stateData.clientName || "Unknown application";
      const { token, id: tokenId } = await createAccessToken(env, {
        userId,
        name: "Device Authorization",
        clientName,
      }) || {};

      if (!token || !tokenId) {
        return serverError("Failed to create access token");
      }

      // Update device authorization
      await env.DB.prepare(
        `
        UPDATE device_authorizations
        SET user_id = ?,
            access_token_id = ?,
            status = 'approved',
            approved_at = ?
        WHERE device_code = ?
      `
      )
        .bind(userId, tokenId, now, stateData.deviceCode)
        .run();

      // Return success HTML
      return new Response(
        `<!DOCTYPE html>
<html>
<head><title>Authentication Complete</title></head>
<body>
<h1>Authentication Complete</h1>
<p>You can now close this window and return to ${escapeHtml(clientName)}.</p>
</body>
</html>`,
        { headers: { "Content-Type": "text/html" } }
      );
    }

    // Web flow - create web session
    const sessionResult = await createWebSession(env, userId);
    if (!sessionResult) {
      return serverError("Failed to create session");
    }

    const cookie = getSessionCookie(sessionResult.sessionToken, sessionResult.expiresAt);

    return new Response(
      `<!DOCTYPE html>
<html>
<head><title>Authentication Complete</title></head>
<body>
<h1>Authentication Complete</h1>
<p>You can now close this window or continue to <a href="/">Dashboard</a>.</p>
</body>
</html>`,
      { headers: { "Content-Type": "text/html", "Set-Cookie": cookie } }
    );
  } catch (error) {
    console.error("[handleGithubCallback] Error:", error);
    return serverError(error instanceof Error ? error.message : "Unknown error");
  }
}

// =============================================================================
// Password Reset
// =============================================================================

/**
 * POST /v1/auth/password/forgot
 * Request password reset
 */
export async function handleForgotPassword(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const body = await request.json() as { email?: string };
    const email = body.email?.trim().toLowerCase();

    if (!email || !EMAIL_REGEX.test(email)) {
      return badRequest("Invalid email address");
    }

    const normalizedEmail = normalizeEmail(email);

    // Find user (don't reveal if exists)
    const user = await env.DB.prepare(
      `SELECT id FROM users WHERE email = ?`
    ).bind(normalizedEmail).first<{ id: string }>();

    if (user) {
      // Create reset token
      const token = await createPasswordResetToken(env, user.id);
      if (token) {
        // TODO: Send actual email
        console.log(`[Password Reset] Token for ${normalizedEmail}: ${token}`);
      }
    }

    // Always return success to prevent email enumeration
    return json({
      success: true,
      message: "If an account exists, a password reset email has been sent.",
    });
  } catch (error) {
    console.error("[handleForgotPassword] Error:", error);
    return serverError(error instanceof Error ? error.message : "Unknown error");
  }
}

/**
 * POST /v1/auth/password/reset
 * Reset password with token
 */
export async function handleResetPassword(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const body = await request.json() as {
      token?: string;
      password?: string;
    };

    const { token, password } = body;

    if (!token || !password) {
      return badRequest("Token and password are required");
    }

    // Validate password strength
    const strength = validatePasswordStrength(password);
    if (!strength.valid) {
      return badRequest(strength.errors.join(", "));
    }

    // Verify token
    const userId = await verifyPasswordResetToken(env, token);
    if (!userId) {
      return badRequest("Invalid or expired token");
    }

    // Mark token as consumed
    await consumePasswordResetToken(env, token);

    // Update password
    const passwordHash = await hashPassword(password);
    const now = Date.now();

    await env.DB.prepare(
      `
      INSERT INTO password_credentials (user_id, password_hash, password_updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT (user_id) DO UPDATE SET
        password_hash = excluded.password_hash,
        password_updated_at = excluded.password_updated_at
    `
    )
      .bind(userId, passwordHash, now)
      .run();

    // Revoke all existing sessions for security
    await env.DB.prepare(
      `DELETE FROM web_sessions WHERE user_id = ?`
    ).bind(userId).run();

    await env.DB.prepare(
      `UPDATE access_tokens SET revoked_at = ? WHERE user_id = ?`
    ).bind(now, userId).run();

    return json({ success: true, message: "Password reset successful" });
  } catch (error) {
    console.error("[handleResetPassword] Error:", error);
    return serverError(error instanceof Error ? error.message : "Unknown error");
  }
}

// =============================================================================
// Email Verification
// =============================================================================

/**
 * GET /v1/auth/email/verify
 * Verify email address
 */
export async function handleVerifyEmail(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const url = new URL(request.url);
    const token = url.searchParams.get("token");

    if (!token) {
      return new Response(
        `<!DOCTYPE html>
<html>
<head><title>Email Verification</title></head>
<body>
<h1>Verification Failed</h1>
<p>Invalid verification token.</p>
</body>
</html>`,
        { headers: { "Content-Type": "text/html" }, status: 400 }
      );
    }

    const userId = await verifyEmailToken(env, token);
    if (!userId) {
      return new Response(
        `<!DOCTYPE html>
<html>
<head><title>Email Verification</title></head>
<body>
<h1>Verification Failed</h1>
<p>This verification link is invalid or has expired.</p>
</body>
</html>`,
        { headers: { "Content-Type": "text/html" }, status: 400 }
      );
    }

    return new Response(
      `<!DOCTYPE html>
<html>
<head><title>Email Verified</title></head>
<body>
<h1>Email Verified</h1>
<p>Your email address has been verified successfully.</p>
<p>You can now close this window.</p>
</body>
</html>`,
      { headers: { "Content-Type": "text/html" } }
    );
  } catch (error) {
    console.error("[handleVerifyEmail] Error:", error);
    return serverError(error instanceof Error ? error.message : "Unknown error");
  }
}

// =============================================================================
// Session & User
// =============================================================================

/**
 * GET /v1/auth/session
 * Get current session info
 */
export async function handleGetAuthSession(
  _request: Request,
  env: Env,
  ctx: RequestContext
): Promise<Response> {
  try {
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
        role: "owner",
      })),
    });
  } catch (error) {
    console.error("[handleGetAuthSession] Error:", error);
    return serverError(error instanceof Error ? error.message : "Unknown error");
  }
}

/**
 * POST /v1/auth/logout
 * Logout user
 */
export async function handleLogout(
  _request: Request,
  env: Env,
  ctx: RequestContext
): Promise<Response> {
  try {
    // Revoke access token if using bearer auth
    if (ctx.accessTokenId) {
      const now = Date.now();
      await env.DB.prepare(
        `UPDATE access_tokens SET revoked_at = ? WHERE id = ?`
      )
        .bind(now, ctx.accessTokenId)
        .run();
    }

    // Destroy web session if using cookie auth
    if (ctx.sessionId) {
      await env.DB.prepare(
        `DELETE FROM web_sessions WHERE id = ?`
      ).bind(ctx.sessionId).run();
    }

    return json({
      success: true,
      message: "Logged out successfully",
    }, {
      headers: { "Set-Cookie": getClearSessionCookie() },
    });
  } catch (error) {
    console.error("[handleLogout] Error:", error);
    return serverError(error instanceof Error ? error.message : "Unknown error");
  }
}

/**
 * GET /v1/me
 * Get current user info
 */
export async function handleGetMe(
  _request: Request,
  env: Env,
  ctx: RequestContext
): Promise<Response> {
  try {
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
