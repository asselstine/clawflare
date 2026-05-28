/**
 * D1 Authentication Repositories
 * 
 * D1-backed implementations for auth repositories.
 */

import type {
  AccessToken,
  AccessTokenListItem,
  CreateAccessTokenParams,
  AccessTokenRepository,
  WebSession,
  WebSessionRepository,
  EmailVerificationToken,
  EmailVerificationTokenRepository,
  PasswordResetToken,
  PasswordResetTokenRepository,
  DeviceAuthorization,
  DeviceAuthorizationRepository,
  DeviceAuthorizationStatus,
} from "../auth.js";

// =============================================================================
// Access Token Repository
// =============================================================================

export class D1AccessTokenRepository implements AccessTokenRepository {
  constructor(private readonly db: D1Database) {}

  async create(
    id: string,
    tokenHash: string,
    params: CreateAccessTokenParams
  ): Promise<void> {
    const now = Date.now();
    await this.db
      .prepare(
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
  }

  async findByTokenHash(tokenHash: string): Promise<AccessToken | null> {
    const row = await this.db
      .prepare(
        `
        SELECT id, user_id, token_hash, name, client_name, created_at, expires_at, revoked_at, last_used_at
        FROM access_tokens
        WHERE token_hash = ?
      `
      )
      .bind(tokenHash)
      .first<{
        id: string;
        user_id: string;
        token_hash: string;
        name: string;
        client_name: string | null;
        created_at: number;
        expires_at: number | null;
        revoked_at: number | null;
        last_used_at: number | null;
      }>();

    if (!row) return null;

    return {
      id: row.id,
      userId: row.user_id,
      tokenHash: row.token_hash,
      name: row.name,
      clientName: row.client_name,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at,
      lastUsedAt: row.last_used_at,
    };
  }

  async updateLastUsedAt(tokenId: string): Promise<void> {
    await this.db
      .prepare(
        `
        UPDATE access_tokens
        SET last_used_at = ?
        WHERE id = ?
      `
      )
      .bind(Date.now(), tokenId)
      .run();
  }

  async revoke(tokenId: string): Promise<void> {
    await this.db
      .prepare(
        `
        UPDATE access_tokens
        SET revoked_at = ?
        WHERE id = ?
      `
      )
      .bind(Date.now(), tokenId)
      .run();
  }

  async listForUser(userId: string): Promise<AccessTokenListItem[]> {
    const rows = await this.db
      .prepare(
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
  }
}

// =============================================================================
// Web Session Repository
// =============================================================================

export class D1WebSessionRepository implements WebSessionRepository {
  constructor(private readonly db: D1Database) {}

  async create(session: Omit<WebSession, "lastSeenAt">): Promise<void> {
    await this.db
      .prepare(
        `
        INSERT INTO web_sessions
          (id, user_id, session_token_hash, csrf_token_hash, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `
      )
      .bind(
        session.id,
        session.userId,
        session.sessionTokenHash,
        session.csrfTokenHash,
        session.expiresAt,
        session.createdAt
      )
      .run();
  }

  async findByTokenHash(sessionTokenHash: string): Promise<WebSession | null> {
    const row = await this.db
      .prepare(
        `
        SELECT id, user_id, session_token_hash, csrf_token_hash, expires_at, created_at, last_seen_at
        FROM web_sessions
        WHERE session_token_hash = ?
      `
      )
      .bind(sessionTokenHash)
      .first<{
        id: string;
        user_id: string;
        session_token_hash: string;
        csrf_token_hash: string;
        expires_at: number;
        created_at: number;
        last_seen_at: number | null;
      }>();

    if (!row) return null;

    return {
      id: row.id,
      userId: row.user_id,
      sessionTokenHash: row.session_token_hash,
      csrfTokenHash: row.csrf_token_hash,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
    };
  }

  async updateLastSeenAt(sessionId: string): Promise<void> {
    await this.db
      .prepare(
        `
        UPDATE web_sessions
        SET last_seen_at = ?
        WHERE id = ?
      `
      )
      .bind(Date.now(), sessionId)
      .run();
  }

  async delete(sessionId: string): Promise<void> {
    await this.db
      .prepare(
        `
        DELETE FROM web_sessions WHERE id = ?
      `
      )
      .bind(sessionId)
      .run();
  }

  async deleteAllForUser(userId: string): Promise<void> {
    await this.db
      .prepare(
        `
        DELETE FROM web_sessions WHERE user_id = ?
      `
      )
      .bind(userId)
      .run();
  }
}

// =============================================================================
// Email Verification Token Repository
// =============================================================================

export class D1EmailVerificationTokenRepository implements EmailVerificationTokenRepository {
  constructor(private readonly db: D1Database) {}

  async create(
    id: string,
    tokenHash: string,
    userId: string,
    expiresAt: number
  ): Promise<void> {
    const now = Date.now();
    await this.db
      .prepare(
        `
        INSERT INTO email_verification_tokens
          (id, user_id, token_hash, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?)
      `
      )
      .bind(id, userId, tokenHash, expiresAt, now)
      .run();
  }

  async findByTokenHash(tokenHash: string): Promise<EmailVerificationToken | null> {
    const row = await this.db
      .prepare(
        `
        SELECT id, user_id, token_hash, expires_at, created_at, consumed_at
        FROM email_verification_tokens
        WHERE token_hash = ?
      `
      )
      .bind(tokenHash)
      .first<{
        id: string;
        user_id: string;
        token_hash: string;
        expires_at: number;
        created_at: number;
        consumed_at: number | null;
      }>();

    if (!row) return null;

    return {
      id: row.id,
      userId: row.user_id,
      tokenHash: row.token_hash,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      consumedAt: row.consumed_at,
    };
  }

  async consume(tokenId: string): Promise<void> {
    await this.db
      .prepare(
        `
        UPDATE email_verification_tokens
        SET consumed_at = ?
        WHERE id = ?
      `
      )
      .bind(Date.now(), tokenId)
      .run();
  }

  async invalidateAllForUser(userId: string): Promise<void> {
    await this.db
      .prepare(
        `
        UPDATE email_verification_tokens
        SET consumed_at = ?
        WHERE user_id = ? AND consumed_at IS NULL
      `
      )
      .bind(Date.now(), userId)
      .run();
  }
}

// =============================================================================
// Password Reset Token Repository
// =============================================================================

export class D1PasswordResetTokenRepository implements PasswordResetTokenRepository {
  constructor(private readonly db: D1Database) {}

  async create(
    id: string,
    tokenHash: string,
    userId: string,
    expiresAt: number
  ): Promise<void> {
    const now = Date.now();
    await this.db
      .prepare(
        `
        INSERT INTO password_reset_tokens
          (id, user_id, token_hash, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?)
      `
      )
      .bind(id, userId, tokenHash, expiresAt, now)
      .run();
  }

  async findByTokenHash(tokenHash: string): Promise<PasswordResetToken | null> {
    const row = await this.db
      .prepare(
        `
        SELECT id, user_id, token_hash, expires_at, created_at, consumed_at
        FROM password_reset_tokens
        WHERE token_hash = ?
      `
      )
      .bind(tokenHash)
      .first<{
        id: string;
        user_id: string;
        token_hash: string;
        expires_at: number;
        created_at: number;
        consumed_at: number | null;
      }>();

    if (!row) return null;

    return {
      id: row.id,
      userId: row.user_id,
      tokenHash: row.token_hash,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      consumedAt: row.consumed_at,
    };
  }

  async consume(tokenId: string): Promise<void> {
    await this.db
      .prepare(
        `
        UPDATE password_reset_tokens
        SET consumed_at = ?
        WHERE id = ?
      `
      )
      .bind(Date.now(), tokenId)
      .run();
  }

  async invalidateAllForUser(userId: string): Promise<void> {
    await this.db
      .prepare(
        `
        UPDATE password_reset_tokens
        SET consumed_at = ?
        WHERE user_id = ? AND consumed_at IS NULL
      `
      )
      .bind(Date.now(), userId)
      .run();
  }
}

// =============================================================================
// Device Authorization Repository
// =============================================================================

export class D1DeviceAuthorizationRepository implements DeviceAuthorizationRepository {
  constructor(private readonly db: D1Database) {}

  async create(
    deviceCode: string,
    userCode: string,
    clientName: string,
    oauthStateHash: string,
    expiresAt: number
  ): Promise<void> {
    const now = Date.now();
    await this.db
      .prepare(
        `
        INSERT INTO device_authorizations
          (device_code, user_code, client_name, status, expires_at, created_at, oauth_state_hash)
        VALUES (?, ?, ?, 'pending', ?, ?, ?)
      `
      )
      .bind(deviceCode, userCode, clientName, expiresAt, now, oauthStateHash)
      .run();
  }

  async findByOAuthStateHash(oauthStateHash: string): Promise<DeviceAuthorization | null> {
    const row = await this.db
      .prepare(
        `
        SELECT device_code, user_code, client_name, status, user_id, access_token_id,
               access_token_plaintext, token_retrieved_at, oauth_state_hash,
               expires_at, created_at, approved_at
        FROM device_authorizations
        WHERE oauth_state_hash = ?
      `
      )
      .bind(oauthStateHash)
      .first<{
        device_code: string;
        user_code: string;
        client_name: string;
        status: string;
        user_id: string | null;
        access_token_id: string | null;
        access_token_plaintext: string | null;
        token_retrieved_at: number | null;
        oauth_state_hash: string;
        expires_at: number;
        created_at: number;
        approved_at: number | null;
      }>();

    if (!row) return null;

    return {
      deviceCode: row.device_code,
      userCode: row.user_code,
      clientName: row.client_name,
      status: row.status as DeviceAuthorizationStatus,
      userId: row.user_id,
      accessTokenId: row.access_token_id,
      accessTokenPlaintext: row.access_token_plaintext,
      tokenRetrievedAt: row.token_retrieved_at,
      oauthStateHash: row.oauth_state_hash,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      approvedAt: row.approved_at,
    };
  }

  async findByUserCode(userCode: string): Promise<DeviceAuthorization | null> {
    const row = await this.db
      .prepare(
        `
        SELECT device_code, user_code, client_name, status, user_id, access_token_id,
               access_token_plaintext, token_retrieved_at, oauth_state_hash,
               expires_at, created_at, approved_at
        FROM device_authorizations
        WHERE user_code = ?
      `
      )
      .bind(userCode)
      .first<{
        device_code: string;
        user_code: string;
        client_name: string;
        status: string;
        user_id: string | null;
        access_token_id: string | null;
        access_token_plaintext: string | null;
        token_retrieved_at: number | null;
        oauth_state_hash: string;
        expires_at: number;
        created_at: number;
        approved_at: number | null;
      }>();

    if (!row) return null;

    return {
      deviceCode: row.device_code,
      userCode: row.user_code,
      clientName: row.client_name,
      status: row.status as DeviceAuthorizationStatus,
      userId: row.user_id,
      accessTokenId: row.access_token_id,
      accessTokenPlaintext: row.access_token_plaintext,
      tokenRetrievedAt: row.token_retrieved_at,
      oauthStateHash: row.oauth_state_hash,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      approvedAt: row.approved_at,
    };
  }

  async findByDeviceCode(deviceCode: string): Promise<DeviceAuthorization | null> {
    const row = await this.db
      .prepare(
        `
        SELECT device_code, user_code, client_name, status, user_id, access_token_id,
               access_token_plaintext, token_retrieved_at, oauth_state_hash,
               expires_at, created_at, approved_at
        FROM device_authorizations
        WHERE device_code = ?
      `
      )
      .bind(deviceCode)
      .first<{
        device_code: string;
        user_code: string;
        client_name: string;
        status: string;
        user_id: string | null;
        access_token_id: string | null;
        access_token_plaintext: string | null;
        token_retrieved_at: number | null;
        oauth_state_hash: string;
        expires_at: number;
        created_at: number;
        approved_at: number | null;
      }>();

    if (!row) return null;

    return {
      deviceCode: row.device_code,
      userCode: row.user_code,
      clientName: row.client_name,
      status: row.status as DeviceAuthorizationStatus,
      userId: row.user_id,
      accessTokenId: row.access_token_id,
      accessTokenPlaintext: row.access_token_plaintext,
      tokenRetrievedAt: row.token_retrieved_at,
      oauthStateHash: row.oauth_state_hash,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      approvedAt: row.approved_at,
    };
  }

  async updateStatus(deviceCode: string, status: DeviceAuthorizationStatus): Promise<void> {
    await this.db
      .prepare(
        `
        UPDATE device_authorizations
        SET status = ?
        WHERE device_code = ?
      `
      )
      .bind(status, deviceCode)
      .run();
  }

  async approve(
    deviceCode: string,
    userId: string,
    accessTokenId: string,
    accessTokenPlaintext: string
  ): Promise<void> {
    await this.db
      .prepare(
        `
        UPDATE device_authorizations
        SET user_id = ?,
            access_token_id = ?,
            access_token_plaintext = ?,
            status = 'approved',
            approved_at = ?
        WHERE device_code = ?
      `
      )
      .bind(userId, accessTokenId, accessTokenPlaintext, Date.now(), deviceCode)
      .run();
  }

  async markTokenRetrieved(deviceCode: string): Promise<void> {
    await this.db
      .prepare(
        `
        UPDATE device_authorizations
        SET access_token_plaintext = NULL,
            token_retrieved_at = ?
        WHERE device_code = ?
      `
      )
      .bind(Date.now(), deviceCode)
      .run();
  }

  async cleanupExpired(beforeTimestamp: number): Promise<number> {
    const result = await this.db
      .prepare(
        `
        DELETE FROM device_authorizations
        WHERE expires_at < ? AND status IN ('pending', 'expired')
      `
      )
      .bind(beforeTimestamp)
      .run();

    return result.meta?.changes ?? 0;
  }
}
