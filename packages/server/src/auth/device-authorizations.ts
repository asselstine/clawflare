// Device authorization flow management
// For CLI, mobile apps, and other clients

import type { Env } from "../internal-types/index.js";
import { createAccessToken } from "./access-tokens.js";

const DEVICE_CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Generate a human-readable user code
 * Format: XXXX-XXXX (alphanumeric, excluding confusing characters)
 */
function generateUserCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // No I, O, 0, 1
  let code = "";
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  
  for (let i = 0; i < 8; i++) {
    const byte = bytes[i];
    if (byte === undefined) continue;
    const charIndex = byte % chars.length;
    code += chars.charAt(charIndex);
    if (i === 3) code += "-";
  }
  
  return code;
}

/**
 * Create a new device authorization
 */
export async function createDeviceAuthorization(
  env: Env,
  clientName: string
): Promise<{
  deviceCode: string;
  userCode: string;
  expiresAt: number;
} | null> {
  try {
    const deviceCode = crypto.randomUUID();
    const userCode = generateUserCode();
    const now = Date.now();
    const expiresAt = now + DEVICE_CODE_TTL_MS;
    
    await env.DB.prepare(
      `
      INSERT INTO device_authorizations
        (device_code, user_code, client_name, status, expires_at, created_at)
      VALUES (?, ?, ?, 'pending', ?, ?)
    `
    )
      .bind(deviceCode, userCode, clientName, expiresAt, now)
      .run();
    
    return { deviceCode, userCode, expiresAt };
  } catch (error) {
    console.error("[createDeviceAuthorization] Error:", error);
    return null;
  }
}

/**
 * Get device authorization by user code
 */
export async function getDeviceAuthorizationByUserCode(
  env: Env,
  userCode: string
): Promise<{
  deviceCode: string;
  clientName: string;
  status: string;
  expiresAt: number;
} | null> {
  try {
    const row = await env.DB.prepare(
      `
      SELECT device_code, client_name, status, expires_at
      FROM device_authorizations
      WHERE user_code = ?
    `
    )
      .bind(userCode.toUpperCase().replace(/[^A-Z0-9]/g, ""))
      .first<{
        device_code: string;
        client_name: string;
        status: string;
        expires_at: number;
      }>();
    
    if (!row) return null;
    
    return {
      deviceCode: row.device_code,
      clientName: row.client_name,
      status: row.status,
      expiresAt: row.expires_at,
    };
  } catch (error) {
    console.error("[getDeviceAuthorizationByUserCode] Error:", error);
    return null;
  }
}

/**
 * Approve a device authorization
 */
export async function approveDeviceAuthorization(
  env: Env,
  deviceCode: string,
  userId: string
): Promise<{ accessToken: string } | null> {
  try {
    const now = Date.now();
    
    // Check if device authorization is still valid
    const deviceAuth = await env.DB.prepare(
      `
      SELECT client_name, status, expires_at
      FROM device_authorizations
      WHERE device_code = ?
    `
    )
      .bind(deviceCode)
      .first<{
        client_name: string;
        status: string;
        expires_at: number;
      }>();
    
    if (!deviceAuth) return null;
    
    if (deviceAuth.status !== "pending") {
      return null;
    }
    
    if (now > deviceAuth.expires_at) {
      // Mark as expired
      await env.DB.prepare(
        `
        UPDATE device_authorizations
        SET status = 'expired'
        WHERE device_code = ?
      `
      )
        .bind(deviceCode)
        .run();
      return null;
    }
    
    // Create access token
    const tokenResult = await createAccessToken(env, {
      userId,
      name: `Device Authorization - ${deviceAuth.client_name}`,
      clientName: deviceAuth.client_name,
    });
    
    if (!tokenResult) return null;
    
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
      .bind(userId, tokenResult.id, now, deviceCode)
      .run();
    
    return { accessToken: tokenResult.token };
  } catch (error) {
    console.error("[approveDeviceAuthorization] Error:", error);
    return null;
  }
}

/**
 * Deny a device authorization
 */
export async function denyDeviceAuthorization(
  env: Env,
  deviceCode: string
): Promise<boolean> {
  try {
    await env.DB.prepare(
      `
      UPDATE device_authorizations
      SET status = 'denied'
      WHERE device_code = ?
    `
    )
      .bind(deviceCode)
      .run();
    return true;
  } catch (error) {
    console.error("[denyDeviceAuthorization] Error:", error);
    return false;
  }
}

/**
 * Poll device authorization status
 */
export async function pollDeviceAuthorization(
  env: Env,
  deviceCode: string
): Promise<
  | {
      status: "pending" | "complete" | "expired" | "denied";
      accessToken?: string;
      userId?: string;
    }
  | null
> {
  try {
    const row = await env.DB.prepare(
      `
      SELECT status, expires_at, user_id, access_token_id
      FROM device_authorizations
      WHERE device_code = ?
    `
    )
      .bind(deviceCode)
      .first<{
        status: string;
        expires_at: number;
        user_id: string | null;
        access_token_id: string | null;
      }>();
    
    if (!row) return null;
    
    const now = Date.now();
    
    // Check expiration
    if (now > row.expires_at && row.status === "pending") {
      await env.DB.prepare(
        `
        UPDATE device_authorizations
        SET status = 'expired'
        WHERE device_code = ?
      `
      )
        .bind(deviceCode)
        .run();
      
      return { status: "expired" };
    }
    
    if (row.status === "denied") {
      return { status: "denied" };
    }
    
    if (row.status !== "approved" || !row.access_token_id) {
      return { status: "pending" };
    }
    
    // Get the access token from the database
    // Note: We don't store the plaintext token, so the client must have saved it
    // This is returned during the approval callback
    return {
      status: "complete",
      userId: row.user_id ?? undefined,
    };
  } catch (error) {
    console.error("[pollDeviceAuthorization] Error:", error);
    return null;
  }
}

/**
 * Clean up expired device authorizations
 * Call this periodically (e.g., from a cron job)
 */
export async function cleanupExpiredDeviceAuthorizations(
  env: Env
): Promise<number> {
  try {
    const now = Date.now();
    const result = await env.DB.prepare(
      `
      DELETE FROM device_authorizations
      WHERE expires_at < ? AND status IN ('pending', 'expired')
    `
    )
      .bind(now - DEVICE_CODE_TTL_MS) // Keep expired ones for a bit for debugging
      .run();
    
    return result.meta?.changes ?? 0;
  } catch (error) {
    console.error("[cleanupExpiredDeviceAuthorizations] Error:", error);
    return 0;
  }
}
