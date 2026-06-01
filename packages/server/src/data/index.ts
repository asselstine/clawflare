// Data layer exports
// This is the primary entry point for the Clawflare data layer

// =============================================================================
// Sessions
// =============================================================================

export type {
  SessionMetadataState,
  SessionSummary,
  SessionListFilter,
  SessionEvent,
  SessionStatus,
  NewSessionEvent,
  CompleteSessionEvent,
  SessionInputEvent,
  QueueStatus,
  EnqueueResult,
  DequeueResult,
} from "./sessions.js";
export {
  InputQueueRepository,
  SessionEventRepository,
  SessionRepository,
} from "./sessions.js";

// =============================================================================
// Workspaces
// =============================================================================

export type {
  User,
  Workspace,
  WorkspaceRole,
  WorkspaceMembership,
} from "./workspaces.js";
export {
  UserRepository,
  WorkspaceRepository,
} from "./workspaces.js";

// =============================================================================
// Stored Code
// =============================================================================

export type {
  StoredCodeEntry,
  UpsertStoredCodeParams,
} from "./stored-code.js";
export { StoredCodeRepository } from "./stored-code.js";

// =============================================================================
// Egress Handlers
// =============================================================================

export type {
  EgressHandlerMetadata,
  UpsertEgressHandlerParams,
} from "./egress-handlers.js";
export { EgressHandlerRepository } from "./egress-handlers.js";

// =============================================================================
// Model Connections
// =============================================================================

export type {
  ModelConnection,
  ModelProvider,
  CreateModelConnectionParams,
  UpdateModelConnectionParams,
} from "./model-connections.js";
export { ModelConnectionRepository } from "./model-connections.js";

// =============================================================================
// Encrypted Secrets
// =============================================================================

export type {
  EncryptedSecretRecord,
  EncryptedSecretStore,
} from "./encrypted-secrets.js";
export {
  EncryptedSecretRepository,
  getEncryptedSecretRepository,
} from "./encrypted-secrets.js";

// =============================================================================
// Snapshots
// =============================================================================

export {
  SessionRuntimeRepository,
  SnapshotRepository,
} from "./snapshots.js";

// =============================================================================
// Job Snapshots
// =============================================================================

export type { JobAuthorizationSnapshot } from "./job-snapshots.js";
export { createJobSnapshot, JobSnapshotRepository } from "./job-snapshots.js";

// =============================================================================
// Auth
// =============================================================================

export type {
  AccessToken,
  AccessTokenListItem,
  CreateAccessTokenParams,
  VerifiedAccessToken,
  WebSession,
  CreateWebSessionResult,
  VerifiedWebSession,
  EmailVerificationToken,
  PasswordResetToken,
  DeviceAuthorization,
  DeviceAuthorizationStatus,
  DeviceAuthorizationListItem,
  CreateDeviceAuthorizationResult,
  PollDeviceAuthorizationResult,
  ApproveDeviceAuthorizationResult,
} from "./auth.js";
export {
  AccessTokenRepository,
  DeviceAuthorizationRepository,
  EmailVerificationTokenRepository,
  PasswordResetTokenRepository,
  WebSessionRepository,
} from "./auth.js";

// =============================================================================
// Errors
// =============================================================================

export {
  DataLayerError,
  SessionNotFoundError,
  QueueFullError,
  StoredCodeNotFoundError,
  EgressHandlerNotFoundError,
} from "./errors.js";
