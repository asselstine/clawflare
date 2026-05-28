// Web session management for browser-based authentication
// Uses HTTP-only cookies

import type { Env } from "../internal-types/index.js";
import { getDataLayer } from "../data/index.js";
import { logger } from "../logger.js";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Generate a secure random string
 */
function generateSecureToken(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
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
 * Create a new web session
 */
export async function createWebSession(
  env: Env,
  userId: string
): Promise<{
  sessionId: string;
  sessionToken: string;
  csrfToken: string;
  expiresAt: number;
} | null> {
  try {
    const sessionId = crypto.randomUUID();
    const sessionToken = generateSecureToken(32);
    const csrfToken = generateSecureToken(32);
    const sessionTokenHash = await hashToken(sessionToken);
    const csrfTokenHash = await hashToken(csrfToken);
    const now = Date.now();
    const expiresAt = now + SESSION_TTL_MS;

    const data = getDataLayer(env);
    await data.webSessions.create({
      id: sessionId,
      userId,
      sessionTokenHash,
      csrfTokenHash,
      expiresAt,
      createdAt: now,
    });

    return {
      sessionId,
      sessionToken,
      csrfToken,
      expiresAt,
    };
  } catch (error) {
    logger.error("Create web session failed", error, {
      function: "createWebSession",
      userId,
    });
    return null;
  }
}

/**
 * Verify a web session
 */
export async function verifyWebSession(
  env: Env,
  sessionToken: string
): Promise<{
  sessionId: string;
  userId: string;
  csrfTokenValid: (token: string) => Promise<boolean>;
} | null> {
  try {
    const sessionTokenHash = await hashToken(sessionToken);

    const data = getDataLayer(env);
    const row = await data.webSessions.findByTokenHash(sessionTokenHash);

    if (!row) return null;

    // Check expiration
    if (Date.now() > row.expiresAt) {
      // Delete expired session
      await data.webSessions.delete(row.id);
      return null;
    }

    // Update last_seen_at
    await data.webSessions.updateLastSeenAt(row.id);

    // Return CSRF validation function
    const storedCsrfHash = row.csrfTokenHash;
    const csrfTokenValid = async (token: string): Promise<boolean> => {
      const hash = await hashToken(token);
      // Constant-time comparison
      if (hash.length !== storedCsrfHash.length) return false;
      let result = 0;
      for (let i = 0; i < hash.length; i++) {
        result |= hash.charCodeAt(i) ^ storedCsrfHash.charCodeAt(i);
      }
      return result === 0;
    };

    return {
      sessionId: row.id,
      userId: row.userId,
      csrfTokenValid,
    };
  } catch (error) {
    logger.error("Verify web session failed", error, {
      function: "verifyWebSession",
    });
    return null;
  }
}

/**
 * Destroy a web session
 */
export async function destroyWebSession(
  env: Env,
  sessionId: string
): Promise<boolean> {
  try {
    const data = getDataLayer(env);
    await data.webSessions.delete(sessionId);
    return true;
  } catch (error) {
    logger.error("Destroy web session failed", error, {
      function: "destroyWebSession",
    });
    return false;
  }
}

/**
 * Destroy all sessions for a user
 */
export async function destroyAllUserSessions(
  env: Env,
  userId: string
): Promise<boolean> {
  try {
    const data = getDataLayer(env);
    await data.webSessions.deleteAllForUser(userId);
    return true;
  } catch (error) {
    logger.error("Destroy all user sessions failed", error, {
      function: "destroyAllUserSessions",
      userId,
    });
    return false;
  }
}

/**
 * Get session cookie string
 */
export function getSessionCookie(sessionToken: string, expiresAt: number): string {
  const maxAge = Math.floor((expiresAt - Date.now()) / 1000);
  return `clawflare_session=${sessionToken}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

/**
 * Clear session cookie
 */
export function getClearSessionCookie(): string {
  return `clawflare_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

/**
 * Extract session token from cookie
 */
export function extractSessionToken(request: Request): string | null {
  const cookie = request.headers.get("Cookie");
  if (!cookie) return null;

  const match = cookie.match(/clawflare_session=([^;]+)/);
  return match?.[1] ?? null;
}

/**
 * Extract CSRF token from headers
 */
export function extractCsrfToken(request: Request): string | null {
  return request.headers.get("X-CSRF-Token");
}
