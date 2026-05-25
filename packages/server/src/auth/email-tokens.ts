// Email verification and password reset token management

import type { Env } from "../internal-types/index.js";

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
    
    // Invalidate any existing tokens for this user
    await env.DB.prepare(
      `
      UPDATE email_verification_tokens
      SET consumed_at = ?
      WHERE user_id = ? AND consumed_at IS NULL
    `
    )
      .bind(now, userId)
      .run();
    
    await env.DB.prepare(
      `
      INSERT INTO email_verification_tokens
        (id, user_id, token_hash, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?)
    `
    )
      .bind(id, userId, tokenHash, expiresAt, now)
      .run();
    
    return token;
  } catch (error) {
    console.error("[createEmailVerificationToken] Error:", error);
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
    
    const row = await env.DB.prepare(
      `
      SELECT id, user_id, expires_at, consumed_at
      FROM email_verification_tokens
      WHERE token_hash = ?
    `
    )
      .bind(tokenHash)
      .first<{
        id: string;
        user_id: string;
        expires_at: number;
        consumed_at: number | null;
      }>();
    
    if (!row) return null;
    
    if (row.consumed_at) return null;
    if (now > row.expires_at) return null;
    
    // Mark as consumed
    await env.DB.prepare(
      `
      UPDATE email_verification_tokens
      SET consumed_at = ?
      WHERE id = ?
    `
    )
      .bind(now, row.id)
      .run();
    
    // Update user as verified
    await env.DB.prepare(
      `
      UPDATE users
      SET email_verified_at = ?
      WHERE id = ?
    `
    )
      .bind(now, row.user_id)
      .run();
    
    return row.user_id;
  } catch (error) {
    console.error("[verifyEmailToken] Error:", error);
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
    
    // Invalidate any existing tokens for this user
    await env.DB.prepare(
      `
      UPDATE password_reset_tokens
      SET consumed_at = ?
      WHERE user_id = ? AND consumed_at IS NULL
    `
    )
      .bind(now, userId)
      .run();
    
    await env.DB.prepare(
      `
      INSERT INTO password_reset_tokens
        (id, user_id, token_hash, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?)
    `
    )
      .bind(id, userId, tokenHash, expiresAt, now)
      .run();
    
    return token;
  } catch (error) {
    console.error("[createPasswordResetToken] Error:", error);
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
    const now = Date.now();
    
    const row = await env.DB.prepare(
      `
      SELECT id, user_id, expires_at, consumed_at
      FROM password_reset_tokens
      WHERE token_hash = ?
    `
    )
      .bind(tokenHash)
      .first<{
        id: string;
        user_id: string;
        expires_at: number;
        consumed_at: number | null;
      }>();
    
    if (!row) return null;
    
    if (row.consumed_at) return null;
    if (now > row.expires_at) return null;
    
    return row.user_id;
  } catch (error) {
    console.error("[verifyPasswordResetToken] Error:", error);
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
    const now = Date.now();
    
    const row = await env.DB.prepare(
      `
      SELECT id, consumed_at
      FROM password_reset_tokens
      WHERE token_hash = ?
    `
    )
      .bind(tokenHash)
      .first<{
        id: string;
        consumed_at: number | null;
      }>();
    
    if (!row || row.consumed_at) return false;
    
    await env.DB.prepare(
      `
      UPDATE password_reset_tokens
      SET consumed_at = ?
      WHERE id = ?
    `
    )
      .bind(now, row.id)
      .run();
    
    return true;
  } catch (error) {
    console.error("[consumePasswordResetToken] Error:", error);
    return false;
  }
}
