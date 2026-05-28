// Email verification and password reset token management

import type { Env } from "../internal-types/index.js";
import { getDataLayer } from "../data/index.js";
import { logger } from "../logger.js";

const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const PASSWORD_RESET_TTL_MS = 1 * 60 * 60 * 1000; // 1 hour

/**
 * Generate a secure random token
 */
function generateSecureToken(): string {
  const bytes = new Uint8Array(32);
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

// =============================================================================
// Email Verification
// =============================================================================

/**
 * Create email verification token
 */
export async function createEmailVerificationToken(
  env: Env,
  userId: string
): Promise<string | null> {
  try {
    const token = generateSecureToken();
    const tokenHash = await hashToken(token);
    const id = crypto.randomUUID();
    const now = Date.now();
    const expiresAt = now + EMAIL_VERIFICATION_TTL_MS;

    const data = getDataLayer(env);

    // Invalidate any existing tokens for this user
    await data.emailVerificationTokens.invalidateAllForUser(userId);

    await data.emailVerificationTokens.create(id, tokenHash, userId, expiresAt);

    return token;
  } catch (error) {
    logger.error("Create email verification token failed", error, {
      function: "createEmailVerificationToken",
      userId,
    });
    return null;
  }
}

/**
 * Verify email verification token
 */
export async function verifyEmailToken(
  env: Env,
  token: string
): Promise<string | null> {
  try {
    const tokenHash = await hashToken(token);
    const now = Date.now();

    const data = getDataLayer(env);
    const row = await data.emailVerificationTokens.findByTokenHash(tokenHash);

    if (!row) return null;
    if (row.consumedAt) return null;
    if (now > row.expiresAt) return null;

    // Mark as consumed
    await data.emailVerificationTokens.consume(row.id);

    // Update user as verified
    await data.users.setEmailVerified(row.userId);

    return row.userId;
  } catch (error) {
    logger.error("Verify email token failed", error, {
      function: "verifyEmailToken",
    });
    return null;
  }
}

// =============================================================================
// Password Reset
// =============================================================================

/**
 * Create password reset token
 */
export async function createPasswordResetToken(
  env: Env,
  userId: string
): Promise<string | null> {
  try {
    const token = generateSecureToken();
    const tokenHash = await hashToken(token);
    const id = crypto.randomUUID();
    const now = Date.now();
    const expiresAt = now + PASSWORD_RESET_TTL_MS;

    const data = getDataLayer(env);

    // Invalidate any existing tokens for this user
    await data.passwordResetTokens.invalidateAllForUser(userId);

    await data.passwordResetTokens.create(id, tokenHash, userId, expiresAt);

    return token;
  } catch (error) {
    logger.error("Create password reset token failed", error, {
      function: "createPasswordResetToken",
      userId,
    });
    return null;
  }
}

/**
 * Verify password reset token
 */
export async function verifyPasswordResetToken(
  env: Env,
  token: string
): Promise<string | null> {
  try {
    const tokenHash = await hashToken(token);

    const data = getDataLayer(env);
    const row = await data.passwordResetTokens.findByTokenHash(tokenHash);

    if (!row) return null;
    if (row.consumedAt) return null;
    if (Date.now() > row.expiresAt) return null;

    return row.userId;
  } catch (error) {
    logger.error("Verify password reset token failed", error, {
      function: "verifyPasswordResetToken",
    });
    return null;
  }
}

/**
 * Consume password reset token
 */
export async function consumePasswordResetToken(
  env: Env,
  token: string
): Promise<boolean> {
  try {
    const tokenHash = await hashToken(token);

    const data = getDataLayer(env);
    const row = await data.passwordResetTokens.findByTokenHash(tokenHash);

    if (!row || row.consumedAt) return false;

    await data.passwordResetTokens.consume(row.id);

    return true;
  } catch (error) {
    logger.error("Consume password reset token failed", error, {
      function: "consumePasswordResetToken",
    });
    return false;
  }
}
