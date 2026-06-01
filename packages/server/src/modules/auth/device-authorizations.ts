// Device authorization flow management
// For CLI, mobile apps, and other clients

import type { Env } from "../../internal-types/index.js";
import { DeviceAuthorizationRepository } from "../../data/index.js";
import { createAccessToken, hashToken } from "./access-tokens.js";
import { logger } from "../../lib/logger.js";

const DEVICE_CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Generate a random OAuth state value
 * Used for secure state passing in OAuth flows
 */
function generateOAuthState(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

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
 * Returns oauthState for building authorization URLs
 */
export async function createDeviceAuthorization(
  env: Env,
  clientName: string
): Promise<{
  deviceCode: string;
  userCode: string;
  oauthState: string;
  expiresAt: number;
} | null> {
  try {
    const deviceCode = crypto.randomUUID();
    const userCode = generateUserCode();
    const oauthState = generateOAuthState();
    const oauthStateHash = await hashToken(oauthState);
    const now = Date.now();
    const expiresAt = now + DEVICE_CODE_TTL_MS;

    const deviceAuthorizations = new DeviceAuthorizationRepository(env.DB);
    await deviceAuthorizations.create(deviceCode, userCode, clientName, oauthStateHash, expiresAt);

    return { deviceCode, userCode, oauthState, expiresAt };
  } catch (error) {
    logger.error("Create device authorization failed", error, {
      function: "createDeviceAuthorization",
      clientName,
    });
    return null;
  }
}

/**
 * Get device authorization by OAuth state hash
 * Used in OAuth callback to find the pending authorization
 */
export async function getDeviceAuthorizationByOAuthState(
  env: Env,
  oauthState: string
): Promise<{
  deviceCode: string;
  clientName: string;
  status: string;
  expiresAt: number;
} | null> {
  try {
    const oauthStateHash = await hashToken(oauthState);

    const deviceAuthorizations = new DeviceAuthorizationRepository(env.DB);
    const row = await deviceAuthorizations.findByOAuthStateHash(oauthStateHash);

    if (!row) return null;

    // Check if expired
    if (Date.now() > row.expiresAt && row.status === "pending") {
      await deviceAuthorizations.updateStatus(row.deviceCode, "expired");
      return null;
    }

    return {
      deviceCode: row.deviceCode,
      clientName: row.clientName,
      status: row.status,
      expiresAt: row.expiresAt,
    };
  } catch (error) {
    logger.error("Get device authorization by OAuth state failed", error, {
      function: "getDeviceAuthorizationByOAuthState",
    });
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
    // Normalize input: uppercase, allow hyphen to match stored format XXXX-XXXX
    const normalizedCode = userCode.toUpperCase().replace(/[^A-Z0-9-]/g, "");

    const deviceAuthorizations = new DeviceAuthorizationRepository(env.DB);
    const row = await deviceAuthorizations.findByUserCode(normalizedCode);

    if (!row) return null;

    return {
      deviceCode: row.deviceCode,
      clientName: row.clientName,
      status: row.status,
      expiresAt: row.expiresAt,
    };
  } catch (error) {
    logger.error("Get device authorization by user code failed", error, {
      function: "getDeviceAuthorizationByUserCode",
    });
    return null;
  }
}

/**
 * Approve a device authorization and store access token for one-time retrieval
 * Returns the access token to be stored temporarily for the polling response
 */
export async function approveDeviceAuthorization(
  env: Env,
  deviceCode: string,
  userId: string
): Promise<{ accessToken: string } | null> {
  try {
    const now = Date.now();

    const deviceAuthorizations = new DeviceAuthorizationRepository(env.DB);

    // Check if device authorization is still valid
    const deviceAuth = await deviceAuthorizations.findByDeviceCode(deviceCode);

    if (!deviceAuth) return null;

    if (deviceAuth.status !== "pending") {
      return null;
    }

    if (now > deviceAuth.expiresAt) {
      // Mark as expired
      await deviceAuthorizations.updateStatus(deviceCode, "expired");
      return null;
    }

    // Create access token
    const tokenResult = await createAccessToken(env, {
      userId,
      name: `Device Authorization - ${deviceAuth.clientName}`,
      clientName: deviceAuth.clientName,
    });

    if (!tokenResult) return null;

    // Update device authorization with token for one-time retrieval
    await deviceAuthorizations.approve(deviceCode, userId, tokenResult.id, tokenResult.token);

    return { accessToken: tokenResult.token };
  } catch (error) {
    logger.error("Approve device authorization failed", error, {
      function: "approveDeviceAuthorization",
    });
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
    const deviceAuthorizations = new DeviceAuthorizationRepository(env.DB);
    await deviceAuthorizations.updateStatus(deviceCode, "denied");
    return true;
  } catch (error) {
    logger.error("Deny device authorization failed", error, {
      function: "denyDeviceAuthorization",
    });
    return false;
  }
}

/**
 * Poll device authorization status
 * Returns access token exactly once via one-time retrieval
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
    const deviceAuthorizations = new DeviceAuthorizationRepository(env.DB);
    const row = await deviceAuthorizations.findByDeviceCode(deviceCode);

    if (!row) return null;

    const now = Date.now();

    // Check expiration
    if (now > row.expiresAt && row.status === "pending") {
      await deviceAuthorizations.updateStatus(deviceCode, "expired");
      return { status: "expired" };
    }

    if (row.status === "denied") {
      return { status: "denied" };
    }

    if (row.status !== "approved" || !row.accessTokenId) {
      return { status: "pending" };
    }

    // Device is approved - handle one-time token retrieval
    // If token was already retrieved, return complete without token
    if (row.tokenRetrievedAt || !row.accessTokenPlaintext) {
      return {
        status: "complete",
        userId: row.userId ?? undefined,
      };
    }

    // One-time token retrieval: clear the plaintext token and mark as retrieved
    const accessToken = row.accessTokenPlaintext;
    await deviceAuthorizations.markTokenRetrieved(deviceCode);

    return {
      status: "complete",
      accessToken,
      userId: row.userId ?? undefined,
    };
  } catch (error) {
    logger.error("Poll device authorization failed", error, {
      function: "pollDeviceAuthorization",
    });
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
    const deviceAuthorizations = new DeviceAuthorizationRepository(env.DB);
    return await deviceAuthorizations.cleanupExpired(Date.now() - DEVICE_CODE_TTL_MS);
  } catch (error) {
    logger.error("Cleanup expired device authorizations failed", error, {
      function: "cleanupExpiredDeviceAuthorizations",
    });
    return 0;
  }
}
