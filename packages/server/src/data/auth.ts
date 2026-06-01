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
  oauthStateHash: string | null;
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

/**
 * Drizzle-backed authentication repositories.
 */

import { and, count, desc, eq, inArray, isNull, lt } from "drizzle-orm";
import { createDb, type Db } from "./db.js";
import {
  accessTokens,
  deviceAuthorizations,
  emailVerificationTokens,
  passwordResetTokens,
  webSessions,
} from "./schema.js";

export class AccessTokenRepository {
  private readonly db: Db;

  constructor(db: Db | D1Database) {
    this.db = "query" in db ? db : createDb(db);
  }

  async create(
    id: string,
    tokenHash: string,
    params: CreateAccessTokenParams
  ): Promise<void> {
    await this.db.insert(accessTokens).values({
      id,
      userId: params.userId,
      tokenHash,
      name: params.name,
      clientName: params.clientName ?? null,
      createdAt: Date.now(),
      expiresAt: params.expiresAt ?? null,
    });
  }

  async findByTokenHash(tokenHash: string): Promise<AccessToken | null> {
    const row = await this.db.query.accessTokens.findFirst({
      where: eq(accessTokens.tokenHash, tokenHash),
    });
    return row ?? null;
  }

  async updateLastUsedAt(tokenId: string): Promise<void> {
    await this.db
      .update(accessTokens)
      .set({ lastUsedAt: Date.now() })
      .where(eq(accessTokens.id, tokenId));
  }

  async revoke(tokenId: string): Promise<void> {
    await this.db
      .update(accessTokens)
      .set({ revokedAt: Date.now() })
      .where(eq(accessTokens.id, tokenId));
  }

  async listForUser(userId: string): Promise<AccessTokenListItem[]> {
    const rows = await this.db.query.accessTokens.findMany({
      where: and(eq(accessTokens.userId, userId), isNull(accessTokens.revokedAt)),
      orderBy: [desc(accessTokens.createdAt)],
    });

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      clientName: row.clientName,
      createdAt: row.createdAt,
      lastUsedAt: row.lastUsedAt,
    }));
  }
}

export class WebSessionRepository {
  private readonly db: Db;

  constructor(db: Db | D1Database) {
    this.db = "query" in db ? db : createDb(db);
  }

  async create(session: Omit<WebSession, "lastSeenAt">): Promise<void> {
    await this.db.insert(webSessions).values({
      id: session.id,
      userId: session.userId,
      sessionTokenHash: session.sessionTokenHash,
      csrfTokenHash: session.csrfTokenHash,
      expiresAt: session.expiresAt,
      createdAt: session.createdAt,
    });
  }

  async findByTokenHash(sessionTokenHash: string): Promise<WebSession | null> {
    const row = await this.db.query.webSessions.findFirst({
      where: eq(webSessions.sessionTokenHash, sessionTokenHash),
    });
    return row ?? null;
  }

  async updateLastSeenAt(sessionId: string): Promise<void> {
    await this.db
      .update(webSessions)
      .set({ lastSeenAt: Date.now() })
      .where(eq(webSessions.id, sessionId));
  }

  async delete(sessionId: string): Promise<void> {
    await this.db.delete(webSessions).where(eq(webSessions.id, sessionId));
  }

  async deleteAllForUser(userId: string): Promise<void> {
    await this.db.delete(webSessions).where(eq(webSessions.userId, userId));
  }
}

export class EmailVerificationTokenRepository {
  private readonly db: Db;

  constructor(db: Db | D1Database) {
    this.db = "query" in db ? db : createDb(db);
  }

  async create(
    id: string,
    tokenHash: string,
    userId: string,
    expiresAt: number
  ): Promise<void> {
    await this.db.insert(emailVerificationTokens).values({
      id,
      userId,
      tokenHash,
      expiresAt,
      createdAt: Date.now(),
    });
  }

  async findByTokenHash(tokenHash: string): Promise<EmailVerificationToken | null> {
    const row = await this.db.query.emailVerificationTokens.findFirst({
      where: eq(emailVerificationTokens.tokenHash, tokenHash),
    });
    return row ?? null;
  }

  async consume(tokenId: string): Promise<void> {
    await this.db
      .update(emailVerificationTokens)
      .set({ consumedAt: Date.now() })
      .where(eq(emailVerificationTokens.id, tokenId));
  }

  async invalidateAllForUser(userId: string): Promise<void> {
    await this.db
      .update(emailVerificationTokens)
      .set({ consumedAt: Date.now() })
      .where(
        and(
          eq(emailVerificationTokens.userId, userId),
          isNull(emailVerificationTokens.consumedAt)
        )
      );
  }
}

export class PasswordResetTokenRepository {
  private readonly db: Db;

  constructor(db: Db | D1Database) {
    this.db = "query" in db ? db : createDb(db);
  }

  async create(
    id: string,
    tokenHash: string,
    userId: string,
    expiresAt: number
  ): Promise<void> {
    await this.db.insert(passwordResetTokens).values({
      id,
      userId,
      tokenHash,
      expiresAt,
      createdAt: Date.now(),
    });
  }

  async findByTokenHash(tokenHash: string): Promise<PasswordResetToken | null> {
    const row = await this.db.query.passwordResetTokens.findFirst({
      where: eq(passwordResetTokens.tokenHash, tokenHash),
    });
    return row ?? null;
  }

  async consume(tokenId: string): Promise<void> {
    await this.db
      .update(passwordResetTokens)
      .set({ consumedAt: Date.now() })
      .where(eq(passwordResetTokens.id, tokenId));
  }

  async invalidateAllForUser(userId: string): Promise<void> {
    await this.db
      .update(passwordResetTokens)
      .set({ consumedAt: Date.now() })
      .where(
        and(
          eq(passwordResetTokens.userId, userId),
          isNull(passwordResetTokens.consumedAt)
        )
      );
  }
}

export class DeviceAuthorizationRepository {
  private readonly db: Db;

  constructor(db: Db | D1Database) {
    this.db = "query" in db ? db : createDb(db);
  }

  async create(
    deviceCode: string,
    userCode: string,
    clientName: string,
    oauthStateHash: string,
    expiresAt: number
  ): Promise<void> {
    await this.db.insert(deviceAuthorizations).values({
      deviceCode,
      userCode,
      clientName,
      status: "pending",
      expiresAt,
      createdAt: Date.now(),
      oauthStateHash,
    });
  }

  async findByOAuthStateHash(oauthStateHash: string): Promise<DeviceAuthorization | null> {
    const row = await this.db.query.deviceAuthorizations.findFirst({
      where: eq(deviceAuthorizations.oauthStateHash, oauthStateHash),
    });
    return row ?? null;
  }

  async findByUserCode(userCode: string): Promise<DeviceAuthorization | null> {
    const row = await this.db.query.deviceAuthorizations.findFirst({
      where: eq(deviceAuthorizations.userCode, userCode),
    });
    return row ?? null;
  }

  async findByDeviceCode(deviceCode: string): Promise<DeviceAuthorization | null> {
    const row = await this.db.query.deviceAuthorizations.findFirst({
      where: eq(deviceAuthorizations.deviceCode, deviceCode),
    });
    return row ?? null;
  }

  async updateStatus(deviceCode: string, status: DeviceAuthorizationStatus): Promise<void> {
    await this.db
      .update(deviceAuthorizations)
      .set({ status })
      .where(eq(deviceAuthorizations.deviceCode, deviceCode));
  }

  async approve(
    deviceCode: string,
    userId: string,
    accessTokenId: string,
    accessTokenPlaintext: string
  ): Promise<void> {
    await this.db
      .update(deviceAuthorizations)
      .set({
        userId,
        accessTokenId,
        accessTokenPlaintext,
        status: "approved",
        approvedAt: Date.now(),
      })
      .where(eq(deviceAuthorizations.deviceCode, deviceCode));
  }

  async markTokenRetrieved(deviceCode: string): Promise<void> {
    await this.db
      .update(deviceAuthorizations)
      .set({
        accessTokenPlaintext: null,
        tokenRetrievedAt: Date.now(),
      })
      .where(eq(deviceAuthorizations.deviceCode, deviceCode));
  }

  async cleanupExpired(beforeTimestamp: number): Promise<number> {
    const rows = await this.db
      .select({ value: count() })
      .from(deviceAuthorizations)
      .where(
        and(
          lt(deviceAuthorizations.expiresAt, beforeTimestamp),
          inArray(deviceAuthorizations.status, ["pending", "expired"])
        )
      );
    const deleted = rows[0]?.value ?? 0;

    await this.db
      .delete(deviceAuthorizations)
      .where(
        and(
          lt(deviceAuthorizations.expiresAt, beforeTimestamp),
          inArray(deviceAuthorizations.status, ["pending", "expired"])
        )
      );

    return deleted;
  }
}
