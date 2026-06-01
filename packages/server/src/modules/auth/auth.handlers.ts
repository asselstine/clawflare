// Auth Route Handlers - /v1/auth/*
// Native email/password + OAuth + device authorization

import type { Env } from "../../internal-types/index.js";
import { json, badRequest, serverError } from "../../http/responses.js";
import { WorkspaceRepository } from "../../data/index.js";
import type { RequestContext } from "../../http/request-context.js";
import { logger } from "../../lib/logger.js";
import {
  hashPassword,
  verifyPassword,
  validatePasswordStrength,
  normalizeEmail,
  createWebSession,
  createDeviceAuthorization,
  getDeviceAuthorizationByOAuthState,
  getDeviceAuthorizationByUserCode,
  denyDeviceAuthorization,
  pollDeviceAuthorization,
  approveDeviceAuthorization,
  getSessionCookie,
  getClearSessionCookie,
  createEmailVerificationToken,
  verifyEmailToken,
  createPasswordResetToken,
  verifyPasswordResetToken,
  consumePasswordResetToken,
} from "./index.js";

// GitHub OAuth configuration
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_API_URL = "https://api.github.com";

const POLL_INTERVAL_SECONDS = 2;
const GITHUB_SCOPES = "read:user user:email";
const HTML_HEADERS = { "Content-Type": "text/html; charset=utf-8" };

// Mock OAuth configuration (for E2E tests only)
const MOCK_OAUTH_USER = {
  email: "e2e-test@clawflare.dev",
  displayName: "E2E Test User",
};

/**
 * GET /v1/auth/mock/auto-approve
 * Auto-approve endpoint for mock OAuth (E2E tests only)
 * Immediately approves the device authorization and creates the test user
 */
export async function handleMockOAuthAutoApprove(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const url = new URL(request.url);
    const deviceCode = url.searchParams.get("code");

    if (!deviceCode) {
      return badRequest("Missing code parameter");
    }

    // Look up the device authorization directly by device code
    const deviceAuth = await env.DB.prepare(
      `SELECT device_code, status, expires_at FROM device_authorizations WHERE device_code = ?`
    ).bind(deviceCode).first<{ device_code: string; status: string; expires_at: number }>();

    if (!deviceAuth) {
      return badRequest("Invalid or expired device code");
    }

    if (deviceAuth.status !== "pending") {
      return badRequest(`Device authorization is ${deviceAuth.status}`);
    }

    if (Date.now() > deviceAuth.expires_at) {
      return badRequest("Device code expired");
    }

    // Create the test user if they don't exist
    const now = Date.now();
    let userId: string;

    // Check if mock user exists
    const existingUser = await env.DB.prepare(
      `SELECT id FROM users WHERE email = ?`
    ).bind(MOCK_OAUTH_USER.email).first<{ id: string }>();

    if (existingUser) {
      userId = existingUser.id;
    } else {
      // Create the mock user
      userId = crypto.randomUUID();
      await env.DB.prepare(
        `
        INSERT INTO users (id, email, display_name, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `
      )
        .bind(userId, MOCK_OAUTH_USER.email, MOCK_OAUTH_USER.displayName, now, now)
        .run();

      // Create default workspace for E2E tests (matches test endpoint expectations)
      const workspaces = new WorkspaceRepository(env.DB);
      const workspaceId = "default-workspace";
      const slug = "e2e-test";

      await workspaces.create({
        id: workspaceId,
        slug,
        name: "E2E Test Workspace",
        description: "Auto-created for E2E tests",
      });

      await workspaces.addMembership({
        workspaceId,
        userId,
        role: "owner",
      });

      // Create a test model connection for the workspace (required for chat tests)
      const modelConnectionId = crypto.randomUUID();
      await env.DB.prepare(`
        INSERT INTO model_connections 
          (id, workspace_id, provider, model_name, display_name, secret_refs_json, config_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        modelConnectionId,
        workspaceId,
        "amazon-bedrock",
        "minimax.minimax-m2.5",
        "E2E Test Model",
        "{}",
        "{}",
        now,
        now
      ).run();

      // Set the model connection as the workspace default
      await env.DB.prepare(`
        UPDATE workspaces SET default_model_connection_id = ? WHERE id = ?
      `).bind(modelConnectionId, workspaceId).run();
    }

    // Approve the device authorization
    const approveResult = await approveDeviceAuthorization(env, deviceCode, userId);
    if (!approveResult) {
      return serverError("Failed to approve device authorization");
    }

    // Return success HTML page
    return new Response(
      `<!DOCTYPE html>
<html>
<head>
<title>Authorization Complete</title>
<style>
body { font-family: system-ui, sans-serif; max-width: 500px; margin: 50px auto; padding: 20px; text-align: center; }
h1 { color: #4CAF50; }
.success { background: #e8f5e9; padding: 20px; border-radius: 8px; margin-top: 20px; }
</style>
</head>
<body>
<h1>✓ Authorization Complete</h1>
<div class="success">
<p>Device authorization approved for <strong>${MOCK_OAUTH_USER.email}</strong>.</p>
<p>You can close this window and return to the CLI.</p>
</div>
</body>
</html>`,
      { headers: HTML_HEADERS }
    );
  } catch (error) {
    logger.error("Mock OAuth auto-approve failed", error, {
      handler: "handleMockOAuthAutoApprove",
      route: "GET /v1/auth/mock/auto-approve",
    });
    return serverError(error instanceof Error ? error.message : "Unknown error");
  }
}

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
    const workspacesRepo = new WorkspaceRepository(env.DB);
    const workspaceId = crypto.randomUUID();
    const slug = `personal-${now.toString(36).slice(-6)}`;

    await workspacesRepo.create({
      id: workspaceId,
      slug,
      name: displayName ? `${displayName}'s Workspace` : "Personal Workspace",
      description: "Your personal workspace",
    });

    await workspacesRepo.addMembership({
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

    const workspaces = await workspacesRepo.listForUser(userId);

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
    logger.error("Registration failed", error, {
      handler: "handleRegister",
      route: "POST /v1/auth/register",
    });
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

    const workspacesRepo = new WorkspaceRepository(env.DB);
    const workspaces = await workspacesRepo.listForUser(userRow.id);

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
    logger.error("Login failed", error, {
      handler: "handleLogin",
      route: "POST /v1/auth/login",
    });
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
    const body = await request.json() as { clientName?: string; provider?: string };
    const clientName = sanitizeClientName(body.clientName);
    const provider = body.provider || "github";

    // Validate provider
    if (provider !== "github" && provider !== "mock") {
      return badRequest("Only 'github' and 'mock' providers are supported");
    }

    // For mock provider, require test mode
    if (provider === "mock" && env.CLAWFLARE_TEST_RUN !== "true") {
      return badRequest("Mock OAuth is only available in test mode");
    }

    const result = await createDeviceAuthorization(env, clientName);
    if (!result) {
      return serverError("Failed to create device authorization");
    }

    const baseUrl = new URL(request.url).origin;
    const verificationUrl = `${baseUrl}/v1/auth/device/verify?code=${result.userCode}`;

    let authorizationUrl: string | undefined;

    if (provider === "mock") {
      // For mock OAuth, use the device code directly (stored in D1, persistent across requests)
      authorizationUrl = `${baseUrl}/v1/auth/mock/auto-approve?code=${result.deviceCode}`;
    } else if (provider === "github") {
      // Build GitHub OAuth authorize URL
      const clientId = env.GITHUB_CLIENT_ID;

      if (clientId) {
        const redirectUri = `${baseUrl}/v1/auth/github/callback`;
        const state = result.oauthState; // Use the secure random state
        const scope = encodeURIComponent(GITHUB_SCOPES);
        authorizationUrl = `https://github.com/login/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${scope}&state=${encodeURIComponent(state)}`;
      }
    }

    return json({
      deviceCode: result.deviceCode,
      userCode: result.userCode,
      verificationUrl,
      authorizationUrl,
      expiresIn: 600, // 10 minutes in seconds
      interval: POLL_INTERVAL_SECONDS,
    });
  } catch (error) {
    logger.error("Device auth start failed", error, {
      handler: "handleDeviceAuthStart",
      route: "POST /v1/auth/device/start",
    });
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
    // Normalize user code: uppercase, keep hyphen, remove invalid chars
    const userCode = url.searchParams.get("code")?.toUpperCase().replace(/[^A-Z0-9-]/g, "");

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
        { headers: HTML_HEADERS, status: 400 }
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
        { headers: HTML_HEADERS, status: 404 }
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
        { headers: HTML_HEADERS }
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
        { headers: HTML_HEADERS, status: 410 }
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
      { headers: HTML_HEADERS }
    );
  } catch (error) {
    logger.error("Device verify failed", error, {
      handler: "handleDeviceVerify",
      route: "GET /v1/auth/device/verify",
    });
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
    // Normalize user code: uppercase, keep hyphen, remove invalid chars
    const userCode = formData.get("code")?.toString().toUpperCase().replace(/[^A-Z0-9-]/g, "");
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
        { headers: HTML_HEADERS, status: 401 }
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
        { headers: HTML_HEADERS }
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
      { headers: HTML_HEADERS }
    );
  } catch (error) {
    logger.error("Device approval failed", error, {
      handler: "handleDeviceApprove",
      route: "POST /v1/auth/device/approve",
    });
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

    // Complete - get user info and return access token
    if (result.status === "complete") {
      const response: { 
        status: "complete"; 
        accessToken?: string; 
        user?: { id: string; email: string; displayName?: string };
      } = { status: "complete" };
      
      // Include access token if available (one-time retrieval)
      if (result.accessToken) {
        response.accessToken = result.accessToken;
      }
      
      // Include user info if available
      if (result.userId) {
        const userRow = await env.DB.prepare(
          `SELECT id, email, display_name FROM users WHERE id = ?`
        ).bind(result.userId).first<{
          id: string;
          email: string;
          display_name: string | null;
        }>();

        if (userRow) {
          response.user = {
            id: userRow.id,
            email: userRow.email,
            displayName: userRow.display_name ?? undefined,
          };
        }
      }
      
      return json(response);
    }

    return json({ status: "complete" });
  } catch (error) {
    logger.error("Device auth poll failed", error, {
      handler: "handleDeviceAuthPoll",
      route: "POST /v1/auth/device/poll",
    });
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
      return new Response(
        `<!DOCTYPE html>
<html>
<head><title>Authentication Error</title></head>
<body>
<h1>Authentication Error</h1>
<p>GitHub returned an error: ${escapeHtml(error)}</p>
<p>Please try again.</p>
</body>
</html>`,
        { headers: HTML_HEADERS, status: 400 }
      );
    }

    if (!code || !state) {
      return new Response(
        `<!DOCTYPE html>
<html>
<head><title>Authentication Error</title></head>
<body>
<h1>Authentication Error</h1>
<p>Missing authorization code or state parameter.</p>
</body>
</html>`,
        { headers: HTML_HEADERS, status: 400 }
      );
    }

    // Look up device authorization by OAuth state
    const deviceAuth = await getDeviceAuthorizationByOAuthState(env, state);
    
    if (!deviceAuth) {
      return new Response(
        `<!DOCTYPE html>
<html>
<head><title>Authentication Expired</title></head>
<body>
<h1>Authentication Expired</h1>
<p>This authentication request has expired or is invalid.</p>
<p>Please run <code>clawflare login</code> again in your terminal.</p>
</body>
</html>`,
        { headers: HTML_HEADERS, status: 410 }
      );
    }

    if (deviceAuth.status !== "pending") {
      return new Response(
        `<!DOCTYPE html>
<html>
<head><title>Already Processed</title></head>
<body>
<h1>Already Processed</h1>
<p>This authentication request has already been ${deviceAuth.status}.</p>
</body>
</html>`,
        { headers: HTML_HEADERS, status: 400 }
      );
    }

    // Exchange code for access token
    const clientId = env.GITHUB_CLIENT_ID;
    const clientSecret = env.GITHUB_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      return new Response(
        `<!DOCTYPE html>
<html>
<head><title>Configuration Error</title></head>
<body>
<h1>Configuration Error</h1>
<p>GitHub OAuth is not configured on this server.</p>
</body>
</html>`,
        { headers: HTML_HEADERS, status: 500 }
      );
    }

    // Calculate base URL for redirect_uri
    const baseUrl = url.origin;

    const tokenResponse = await fetch(GITHUB_TOKEN_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": "Clawflare-Auth",
      },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: `${baseUrl}/v1/auth/github/callback`,
      }),
    });

    // Check if response is JSON before parsing
    const contentType = tokenResponse.headers.get("content-type");
    if (!contentType?.includes("application/json")) {
      const text = await tokenResponse.text();
      logger.warn("GitHub OAuth returned non-JSON response", {
        handler: "handleGithubCallback",
        status: tokenResponse.status,
        statusText: tokenResponse.statusText,
        bodyPreview: text.slice(0, 500),
      });
      return new Response(
        `<!DOCTYPE html>
<html>
<head><title>Authentication Failed</title></head>
<body>
<h1>Authentication Failed</h1>
<p>GitHub returned an unexpected response (${tokenResponse.status}).</p>
<p>Please try again.</p>
</body>
</html>`,
        { headers: HTML_HEADERS, status: 400 }
      );
    }

    const tokenData = (await tokenResponse.json()) as {
      access_token?: string;
      error?: string;
      error_description?: string;
    };

    if (tokenData.error || !tokenData.access_token) {
      logger.warn("GitHub OAuth error response", {
        handler: "handleGithubCallback",
        error: tokenData.error,
        errorDescription: tokenData.error_description,
      });
      const errorMsg = tokenData.error_description || tokenData.error || "Unknown error";
      return new Response(
        `<!DOCTYPE html>
<html>
<head><title>Authentication Failed</title></head>
<body>
<h1>Authentication Failed</h1>
<p>GitHub returned an error: ${escapeHtml(errorMsg)}</p>
<p>Please try again.</p>
</body>
</html>`,
        { headers: HTML_HEADERS, status: 400 }
      );
    }

    const githubAccessToken = tokenData.access_token;

    // Get user info from GitHub
    const userResponse = await fetch(`${GITHUB_API_URL}/user`, {
      headers: {
        Authorization: `Bearer ${githubAccessToken}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "Clawflare-Auth",
      },
    });

    if (!userResponse.ok) {
      const errorText = await userResponse.text();
      logger.warn("GitHub API error", {
        handler: "handleGithubCallback",
        status: userResponse.status,
        statusText: userResponse.statusText,
        bodyPreview: errorText.slice(0, 500),
      });
      return new Response(
        `<!DOCTYPE html>
<html>
<head><title>Authentication Failed</title></head>
<body>
<h1>Authentication Failed</h1>
<p>Failed to fetch user data from GitHub (${userResponse.status}).</p>
<p>Please try again.</p>
</body>
</html>`,
        { headers: HTML_HEADERS, status: 400 }
      );
    }

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
          "User-Agent": "Clawflare-Auth",
        },
      });

      if (!emailsResponse.ok) {
        logger.warn("GitHub emails API error", {
          handler: "handleGithubCallback",
          status: emailsResponse.status,
          statusText: emailsResponse.statusText,
        });
      } else {
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
    }

    if (!email) {
      return new Response(
        `<!DOCTYPE html>
<html>
<head><title>Email Required</title></head>
<body>
<h1>Email Required</h1>
<p>GitHub did not provide an email address.</p>
<p>Please ensure your GitHub account has a verified email.</p>
</body>
</html>`,
        { headers: HTML_HEADERS, status: 400 }
      );
    }

    const now = Date.now();
    const normalizedEmail = normalizeEmail(email);
    const displayName = githubUser.name || githubUser.login;

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
        .bind(displayName, now, userId)
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
        .bind(userId, normalizedEmail, displayName, now, now)
        .run();

      // Create personal workspace
      const workspaces = new WorkspaceRepository(env.DB);
      const workspaceId = crypto.randomUUID();
      const slug = `personal-${now.toString(36).slice(-6)}`;

      await workspaces.create({
        id: workspaceId,
        slug,
        name: "Personal Workspace",
        description: "Your personal workspace",
      });

      await workspaces.addMembership({
        workspaceId,
        userId,
        role: "owner",
      });
    }

    // Approve the device authorization and store token for one-time retrieval
    const approvalResult = await approveDeviceAuthorization(env, deviceAuth.deviceCode, userId);

    if (!approvalResult) {
      return new Response(
        `<!DOCTYPE html>
<html>
<head><title>Authentication Failed</title></head>
<body>
<h1>Authentication Failed</h1>
<p>Could not complete device authorization.</p>
<p>Please try again.</p>
</body>
</html>`,
        { headers: HTML_HEADERS, status: 500 }
      );
    }

    // Return success HTML
    return new Response(
      `<!DOCTYPE html>
<html>
<head>
<title>Authentication Complete</title>
<style>
body { font-family: system-ui, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px; text-align: center; }
h1 { color: #4CAF50; }
.success-icon { font-size: 64px; margin: 20px 0; }
.instructions { background: #f5f5f5; padding: 20px; border-radius: 8px; margin: 20px 0; }
code { background: #e0e0e0; padding: 2px 6px; border-radius: 3px; font-family: monospace; }
</style>
</head>
<body>
<h1>Authentication Complete</h1>
<div class="success-icon">✓</div>
<p>You are now authenticated with Clawflare.</p>
<div class="instructions">
<p>You can close this window and return to your terminal.</p>
<p>Run <code>clawflare open</code> to start using Clawflare.</p>
</div>
<p><small>Clawflare CLI authentication successful</small></p>
</body>
</html>`,
      { headers: HTML_HEADERS }
    );
  } catch (error) {
    logger.error("GitHub callback failed", error, {
      handler: "handleGithubCallback",
      route: "GET /v1/auth/github/callback",
    });
    return new Response(
      `<!DOCTYPE html>
<html>
<head><title>Authentication Error</title></head>
<body>
<h1>Authentication Error</h1>
<p>An unexpected error occurred.</p>
<p>Please try again.</p>
</body>
</html>`,
      { headers: HTML_HEADERS, status: 500 }
    );
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
    logger.error("Forgot password failed", error, {
      handler: "handleForgotPassword",
      route: "POST /v1/auth/password/forgot",
    });
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
    logger.error("Reset password failed", error, {
      handler: "handleResetPassword",
      route: "POST /v1/auth/password/reset",
    });
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
        { headers: HTML_HEADERS, status: 400 }
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
        { headers: HTML_HEADERS, status: 400 }
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
      { headers: HTML_HEADERS }
    );
  } catch (error) {
    logger.error("Email verify failed", error, {
      handler: "handleVerifyEmail",
      route: "GET /v1/auth/email/verify",
    });
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
    const workspacesRepo = new WorkspaceRepository(env.DB);
    const workspaces = await workspacesRepo.listForUser(ctx.user.id);

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
    logger.error("Get auth session failed", error, {
      handler: "handleGetAuthSession",
      route: "GET /v1/auth/session",
    });
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
    logger.error("Logout failed", error, {
      handler: "handleLogout",
      route: "POST /v1/auth/logout",
    });
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
    const workspacesRepo = new WorkspaceRepository(env.DB);
    const workspaces = await workspacesRepo.listForUser(ctx.user.id);

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
    logger.error("Get current user failed", error, {
      handler: "handleGetMe",
      route: "GET /v1/me",
    });
    return serverError(error instanceof Error ? error.message : "Unknown error");
  }
}
