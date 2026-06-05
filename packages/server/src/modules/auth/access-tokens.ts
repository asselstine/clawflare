// Access token management for programmatic clients
// CLI, API clients, etc.

import type { Env } from "../../internal-types/index.js";
import { AccessTokenRepository } from "../../data/index.js";
import { logger } from "../../lib/logger.js";

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

    const accessTokens = new AccessTokenRepository(env.DB);
    await accessTokens.create(id, tokenHash, {
      userId: params.userId,
      name: params.name,
      clientName: params.clientName,
      expiresAt: params.expiresAt,
    });

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
    // logger.debug("Verifying access token", { tokenLength: token.length, tokenPrefix: token.slice(0, 15) });
    const tokenHash = await hashToken(token);

    const accessTokens = new AccessTokenRepository(env.DB);
    const row = await accessTokens.findByTokenHash(tokenHash);

    if (!row) {
      // logger.debug("Access token not found", { tokenHashPrefix: tokenHash.slice(0, 16) });
      return null;
    }

    // Check if token is expired
    if (row.expiresAt && Date.now() > row.expiresAt) {
      // logger.debug("Access token expired", { tokenId: row.id, expiresAt: row.expiresAt });
      return null;
    }

    // Check if token is revoked
    if (row.revokedAt) {
      // logger.debug("Access token revoked", { tokenId: row.id, revokedAt: row.revokedAt });
      return null;
    }

    return { tokenId: row.id, userId: row.userId };
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
    const accessTokens = new AccessTokenRepository(env.DB);
    await accessTokens.revoke(tokenId);
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
    const accessTokens = new AccessTokenRepository(env.DB);
    return await accessTokens.listForUser(userId);
  } catch (error) {
    logger.error("Failed to list access tokens", { error: error instanceof Error ? error.message : String(error) });
    return [];
  }
}
