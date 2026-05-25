// HTTP Router - Route dispatching and matching
// Handles all HTTP routes for the Clawflare harness

import type { Env } from "../internal-types/index.js";
import { json, notFound, unauthorized } from "./responses.js";
import { handleChat } from "./routes/chat.js";
import { handleGetSession, handleCloseSession, handleListSessions } from "./routes/sessions.js";
import { handleCreateSession } from "./routes/session-create.js";
import { handleGetContext, handleNewContext } from "./routes/context.js";
import { handleListTools } from "./routes/tools.js";
import { handleGetInfo } from "./routes/info.js";
import { handleCfDebug } from "./routes/debug.js";
import {
  handleDeviceAuthStart,
  handleDeviceAuthPoll,
  handleGithubCallback,
  handleGetMe,
  handleLogout,
} from "./routes/auth.js";
import {
  getBearerToken,
  resolveRequestContext,
} from "./request-context.js";

// Routes that don't require authentication
const PUBLIC_ROUTES = [
  /^\/health$/,
  /^\/v1\/auth\/device\/start$/,
  /^\/v1\/auth\/device\/poll$/,
  /^\/v1\/auth\/github\/callback$/,
];

/**
 * Check if a route is public (no auth required)
 */
function isPublicRoute(path: string): boolean {
  return PUBLIC_ROUTES.some((pattern) => pattern.test(path));
}

/**
 * Main HTTP request handler
 * Routes requests to appropriate handlers based on path and method
 */
export async function handleHttpRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/$/, ""); // Normalize trailing slash
  const isSessionPoll = request.method === "GET" && path.startsWith("/v1/session/");

  if (!isSessionPoll) {
    console.log(`[REQUEST] ${request.method} ${request.url}`);
  }

  // Health check (no auth required)
  if (path === "/health") {
    return json({ status: "ok" });
  }

  // Auth routes - no authentication required
  if (path === "/v1/auth/device/start" && request.method === "POST") {
    return handleDeviceAuthStart(request, env);
  }

  if (path === "/v1/auth/device/poll" && request.method === "POST") {
    return handleDeviceAuthPoll(request, env);
  }

  if (path === "/v1/auth/github/callback" && request.method === "GET") {
    return handleGithubCallback(request, env);
  }

  // Check if this is a public route
  if (isPublicRoute(path)) {
    return notFound();
  }

  // Authenticate all other requests
  const token = getBearerToken(request);
  if (!token) {
    return unauthorized("Missing Authorization header");
  }

  // Resolve request context from access token
  const requestContext = await resolveRequestContext(token, env);

  if (!requestContext) {
    return unauthorized("Invalid token");
  }

  // WebSocket upgrade for interactive workflow sessions
  if (path === "/ws") {
    const id = env.WEBSOCKET_SESSION.idFromName(crypto.randomUUID());
    return env.WEBSOCKET_SESSION.get(id).fetch(request);
  }

  // Route matching
  // Use a simple switch on path prefix + method for clarity

  // /v1/me - GET (current user info)
  if (path === "/v1/me" && request.method === "GET") {
    return handleGetMe(request, env, requestContext);
  }

  // /v1/auth/logout - POST
  if (path === "/v1/auth/logout" && request.method === "POST") {
    return handleLogout(request, env, requestContext);
  }

  // /v1/chat - POST
  if (path === "/v1/chat" && request.method === "POST") {
    return handleChat(request, env, requestContext);
  }

  // /v1/session - POST (create new session without prompt)
  if (path === "/v1/session" && request.method === "POST") {
    return await handleCreateSession(request, env, requestContext);
  }

  // /v1/session/:id - GET
  if ((path.match(/^\/v1\/session\/[^\/]+$/) || path.startsWith("/v1/session/")) && request.method === "GET") {
    // Extract sessionId from path
    const sessionId = path.replace("/v1/session/", "").replace("/close", "").split("/")[0];
    if (sessionId && !path.includes("/close")) {
      return handleGetSession(sessionId, url, env, requestContext);
    }
  }

  // /v1/session/:id/close - POST
  if (path.startsWith("/v1/session/") && path.endsWith("/close") && request.method === "POST") {
    const sessionId = path.replace("/v1/session/", "").replace("/close", "");
    return handleCloseSession(sessionId, env, requestContext);
  }

  // /v1/sessions - GET
  if (path === "/v1/sessions" && request.method === "GET") {
    return handleListSessions(url, env, requestContext);
  }

  // /v1/context - GET
  if (path === "/v1/context" && request.method === "GET") {
    return await handleGetContext(request, env, requestContext);
  }

  // /v1/context - POST
  if (path === "/v1/context" && request.method === "POST") {
    return await handleNewContext(request, env, requestContext);
  }

  // /v1/tools - GET
  if (path === "/v1/tools" && request.method === "GET") {
    return handleListTools(env, ctx);
  }

  // /v1/info - GET
  if (path === "/v1/info" && request.method === "GET") {
    return handleGetInfo(env);
  }

  // /v1/cf_debug - GET
  if (path === "/v1/cf_debug" && request.method === "GET") {
    return handleCfDebug(env, url, requestContext);
  }

  // 404 for unmatched routes
  return notFound();
}

/**
 * Extract the base path for route matching
 * Normalizes trailing slashes
 */
export function normalizePath(request: Request): { path: string; url: URL } {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/$/, "");
  return { path, url };
}

/**
 * Check if a request is for a specific route pattern
 * Useful for route-specific logging or middleware
 */
export function isRoute(request: Request, pattern: RegExp): boolean {
  const { path } = normalizePath(request);
  return pattern.test(path);
}