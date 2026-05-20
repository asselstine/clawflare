// HTTP Authentication Utilities
// Token extraction and validation for Worker routes

import type { Env } from "../internal-types/index.js";

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
 * Validate that the harness API token matches
 * Returns null if valid, otherwise returns an error Response
 */
export function validateHarnessToken(request: Request, env: Env): Response | null {
  const token = getBearerToken(request);
  if (!token || token !== env.CLAWFLARE_API_TOKEN) {
    const body = JSON.stringify({ error: "Unauthorized" });
    return new Response(body, {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  return null;
}

/**
 * Validate that the harness is properly configured
 * Returns a 500 response if CLAWFLARE_API_TOKEN is not configured
 */
export function validateHarnessConfigured(env: Env): Response | null {
  if (!env.CLAWFLARE_API_TOKEN || env.CLAWFLARE_API_TOKEN.trim() === "") {
    console.error("[ERROR] CLAWFLARE_API_TOKEN not configured");
    const body = JSON.stringify({
      error:
        "CLAWFLARE_API_TOKEN not configured. Set via: wrangler secret put CLAWFLARE_API_TOKEN or create a .dev.vars file",
    });
    return new Response(body, {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
  return null;
}

/**
 * Simple synchronous authentication check for use in route handlers
 * Returns true if the token is valid
 */
export function isAuthenticated(request: Request, env: Env): boolean {
  const token = getBearerToken(request);
  return token === env.CLAWFLARE_API_TOKEN;
}
