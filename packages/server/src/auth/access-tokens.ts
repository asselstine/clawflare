// Access token management for programmatic clients
// CLI, API clients, etc.

import type { Env } from "../internal-types/index.js";
import { logger } from "../logger.js";

const TOKEN_PREFIX = "clf_";

/**
 * Generate a secure opaque access token
 * Format: clf_<base64url-encoded-random-bytes>
 */
export function generateAccessToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const encoded = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `${TOKEN_PREFIX}${encoded}`;
}

/**
 * Hash a token using SHA-256 for database storage
 */
export async function hashToken(token: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(token);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Create a new access token
 */
export async function createAccessToken(
  env: Env,
  params: {
    userId: string;
    name: string;
    clientName?: string;
    expiresAt?: number;
  }
): Promise<{ id: string; token: string } | null> {
  try {
    const token = generateAccessToken();
    const tokenHash = await hashToken(token);
    const id = crypto.randomUUID();
    const now = Date.now();
    
    await env.DB.prepare(
      `
      INSERT INTO access_tokens
        (id, user_id, token_hash, name, client_name, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `
    )
      .bind(
        id,
        params.userId,
        tokenHash,
        params.name,
        params.clientName ?? null,
        now,
        params.expiresAt ?? null
      )
      .run();
    
    return { id, token };
  } catch (error) {
    logger.error("Failed to create access token", { error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

/**
 * Verify an access token and return user info if valid
 */
export async function verifyAccessToken(
  env: Env,
  token: string
): Promise<{
  tokenId: string;
  userId: string;
} | null> {
  try {
    logger.debug("Verifying access token", { tokenLength: token.length, tokenPrefix: token.slice(0, 15) });
    const tokenHash = await hashToken(token);

    const row = await env.DB.prepare(
      `
      SELECT id, user_id, expires_at, revoked_at
      FROM access_tokens
      WHERE token_hash = ?
    `
    )
      .bind(tokenHash)
      .first<{
        id: string;
        user_id: string;
        expires_at: number | null;
        revoked_at: number | null;
      }>();

    if (!row) {
      logger.debug("Access token not found", { tokenHashPrefix: tokenHash.slice(0, 16) });
      return null;
    }

    // Check if token is expired
    if (row.expires_at && Date.now() > row.expires_at) {
      logger.debug("Access token expired", { tokenId: row.id, expiresAt: row.expires_at });
      return null;
    }

    // Check if token is revoked
    if (row.revoked_at) {
      logger.debug("Access token revoked", { tokenId: row.id, revokedAt: row.revoked_at });
      return null;
    }

    logger.debug("Access token verified", { tokenId: row.id, userId: row.user_id });

    // Update last_used_at
    await env.DB.prepare(
      `
      UPDATE access_tokens
      SET last_used_at = ?
      WHERE id = ?
    `
    )
      .bind(Date.now(), row.id)
      .run();

    return { tokenId: row.id, userId: row.user_id };
  } catch (error) {
    logger.error("Failed to verify access token", { error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

/**
 * Revoke an access token
 */
export async function revokeAccessToken(
  env: Env,
  tokenId: string
): Promise<boolean> {
  try {
    const now = Date.now();
    await env.DB.prepare(
      `
      UPDATE access_tokens
      SET revoked_at = ?
      WHERE id = ?
    `
    )
      .bind(now, tokenId)
      .run();
    return true;
  } catch (error) {
    logger.error("Failed to revoke access token", { error: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

/**
 * List access tokens for a user
 */
export async function listAccessTokens(
  env: Env,
  userId: string
): Promise<
  Array<{
    id: string;
    name: string;
    clientName: string | null;
    createdAt: number;
    lastUsedAt: number | null;
  }>
> {
  try {
    const rows = await env.DB.prepare(
      `
      SELECT id, name, client_name, created_at, last_used_at
      FROM access_tokens
      WHERE user_id = ? AND revoked_at IS NULL
      ORDER BY created_at DESC
    `
    )
      .bind(userId)
      .all<{
        id: string;
        name: string;
        client_name: string | null;
        created_at: number;
        last_used_at: number | null;
      }>();
    
    return (rows.results ?? []).map((row) => ({
      id: row.id,
      name: row.name,
      clientName: row.client_name,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
    }));
  } catch (error) {
    logger.error("Failed to list access tokens", { error: error instanceof Error ? error.message : String(error) });
    return [];
  }
}
