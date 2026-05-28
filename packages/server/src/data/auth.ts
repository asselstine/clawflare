/**
 * Authentication Data Types
 * 
 * Domain types for authentication (access tokens, sessions, email tokens, device auth).
 */

// =============================================================================
// Access Token Types
// =============================================================================

export interface AccessToken {
  id: string;
  userId: string;
  tokenHash: string;
  name: string;
  clientName: string | null;
  createdAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
  lastUsedAt: number | null;
}

export interface AccessTokenListItem {
  id: string;
  name: string;
  clientName: string | null;
  createdAt: number;
  lastUsedAt: number | null;
}

export interface CreateAccessTokenParams {
  userId: string;
  name: string;
  clientName?: string;
  expiresAt?: number;
}

export interface VerifiedAccessToken {
  tokenId: string;
  userId: string;
}

// =============================================================================
// Web Session Types
// =============================================================================

export interface WebSession {
  id: string;
  userId: string;
  sessionTokenHash: string;
  csrfTokenHash: string;
  expiresAt: number;
  createdAt: number;
  lastSeenAt: number | null;
}

export interface CreateWebSessionResult {
  sessionId: string;
  sessionToken: string;
  csrfToken: string;
  expiresAt: number;
}

export interface VerifiedWebSession {
  sessionId: string;
  userId: string;
  csrfTokenValid: (token: string) => Promise<boolean>;
}

// =============================================================================
// Email Verification Token Types
// =============================================================================

export interface EmailVerificationToken {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: number;
  createdAt: number;
  consumedAt: number | null;
}

// =============================================================================
// Password Reset Token Types
// =============================================================================

export interface PasswordResetToken {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: number;
  createdAt: number;
  consumedAt: number | null;
}

// =============================================================================
// Device Authorization Types
// =============================================================================

export type DeviceAuthorizationStatus = "pending" | "approved" | "denied" | "expired";

export interface DeviceAuthorization {
  deviceCode: string;
  userCode: string;
  clientName: string;
  status: DeviceAuthorizationStatus;
  userId: string | null;
  accessTokenId: string | null;
  accessTokenPlaintext: string | null;
  tokenRetrievedAt: number | null;
  oauthStateHash: string;
  expiresAt: number;
  createdAt: number;
  approvedAt: number | null;
}

export interface DeviceAuthorizationListItem {
  deviceCode: string;
  clientName: string;
  status: DeviceAuthorizationStatus;
  expiresAt: number;
}

export interface CreateDeviceAuthorizationResult {
  deviceCode: string;
  userCode: string;
  oauthState: string;
  expiresAt: number;
}

export interface PollDeviceAuthorizationResult {
  status: "pending" | "complete" | "expired" | "denied";
  accessToken?: string;
  userId?: string;
}

export interface ApproveDeviceAuthorizationResult {
  accessToken: string;
}

// =============================================================================
// Repository Interfaces
// =============================================================================

export interface AccessTokenRepository {
  create(id: string, tokenHash: string, params: CreateAccessTokenParams): Promise<void>;
  findByTokenHash(tokenHash: string): Promise<AccessToken | null>;
  updateLastUsedAt(tokenId: string): Promise<void>;
  revoke(tokenId: string): Promise<void>;
  listForUser(userId: string): Promise<AccessTokenListItem[]>;
}

export interface WebSessionRepository {
  create(session: Omit<WebSession, "lastSeenAt">): Promise<void>;
  findByTokenHash(sessionTokenHash: string): Promise<WebSession | null>;
  updateLastSeenAt(sessionId: string): Promise<void>;
  delete(sessionId: string): Promise<void>;
  deleteAllForUser(userId: string): Promise<void>;
}

export interface EmailVerificationTokenRepository {
  create(id: string, tokenHash: string, userId: string, expiresAt: number): Promise<void>;
  findByTokenHash(tokenHash: string): Promise<EmailVerificationToken | null>;
  consume(tokenId: string): Promise<void>;
  invalidateAllForUser(userId: string): Promise<void>;
}

export interface PasswordResetTokenRepository {
  create(id: string, tokenHash: string, userId: string, expiresAt: number): Promise<void>;
  findByTokenHash(tokenHash: string): Promise<PasswordResetToken | null>;
  consume(tokenId: string): Promise<void>;
  invalidateAllForUser(userId: string): Promise<void>;
}

export interface DeviceAuthorizationRepository {
  create(deviceCode: string, userCode: string, clientName: string, oauthStateHash: string, expiresAt: number): Promise<void>;
  findByOAuthStateHash(oauthStateHash: string): Promise<DeviceAuthorization | null>;
  findByUserCode(userCode: string): Promise<DeviceAuthorization | null>;
  findByDeviceCode(deviceCode: string): Promise<DeviceAuthorization | null>;
  updateStatus(deviceCode: string, status: DeviceAuthorizationStatus): Promise<void>;
  approve(deviceCode: string, userId: string, accessTokenId: string, accessTokenPlaintext: string): Promise<void>;
  markTokenRetrieved(deviceCode: string): Promise<void>;
  cleanupExpired(beforeTimestamp: number): Promise<number>;
}
