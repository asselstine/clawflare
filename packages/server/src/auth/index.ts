// Auth module exports
// Native email/password + device authorization auth system

export {
  hashPassword,
  verifyPassword,
  validatePasswordStrength,
  normalizeEmail,
} from "./password.js";

export {
  createAccessToken,
  verifyAccessToken,
  revokeAccessToken,
  listAccessTokens,
  hashToken,
  generateAccessToken,
} from "./access-tokens.js";

export {
  createDeviceAuthorization,
  getDeviceAuthorizationByUserCode,
  approveDeviceAuthorization,
  denyDeviceAuthorization,
  pollDeviceAuthorization,
  cleanupExpiredDeviceAuthorizations,
} from "./device-authorizations.js";

export {
  createWebSession,
  verifyWebSession,
  destroyWebSession,
  destroyAllUserSessions,
  getSessionCookie,
  getClearSessionCookie,
  extractSessionToken,
  extractCsrfToken,
} from "./sessions.js";

export {
  createEmailVerificationToken,
  verifyEmailToken,
  createPasswordResetToken,
  verifyPasswordResetToken,
  consumePasswordResetToken,
} from "./email-tokens.js";
