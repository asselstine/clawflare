// Web session management for browser-based authentication
// Uses HTTP-only cookies

import type { Env } from "../internal-types/index.js";
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
    
    await env.DB.prepare(
      `
      INSERT INTO web_sessions
        (id, user_id, session_token_hash, csrf_token_hash, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `
    )
      .bind(sessionId, userId, sessionTokenHash, csrfTokenHash, expiresAt, now)
      .run();
    
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
    
    const row = await env.DB.prepare(
      `
      SELECT id, user_id, csrf_token_hash, expires_at
      FROM web_sessions
      WHERE session_token_hash = ?
    `
    )
      .bind(sessionTokenHash)
      .first<{
        id: string;
        user_id: string;
        csrf_token_hash: string;
        expires_at: number;
      }>();
    
    if (!row) return null;
    
    // Check expiration
    if (Date.now() > row.expires_at) {
      // Delete expired session
      await env.DB.prepare(
        `
        DELETE FROM web_sessions WHERE id = ?
      `
      )
        .bind(row.id)
        .run();
      return null;
    }
    
    // Update last_seen_at
    await env.DB.prepare(
      `
      UPDATE web_sessions
      SET last_seen_at = ?
      WHERE id = ?
    `
    )
      .bind(Date.now(), row.id)
      .run();
    
    // Return CSRF validation function
    const storedCsrfHash = row.csrf_token_hash;
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
      userId: row.user_id,
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
    await env.DB.prepare(
      `
      DELETE FROM web_sessions WHERE id = ?
    `
    )
      .bind(sessionId)
      .run();
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
    await env.DB.prepare(
      `
      DELETE FROM web_sessions WHERE user_id = ?
    `
    )
      .bind(userId)
      .run();
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
