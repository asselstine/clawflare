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
export type {
  MessageListOptions,
} from "./messages.js";
export {
  applySessionEventProjection,
  SessionMessageRepository,
} from "./messages.js";

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
// Providers and Models
// =============================================================================

export type {
  Provider,
  Model,
  ModelProvider,
  CreateProviderParams,
  UpdateProviderParams,
  DeleteProviderResult,
  CreateModelParams,
  UpdateModelParams,
} from "./models.js";
export { ProviderRepository, ModelRepository } from "./models.js";

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
// Session Runs
// =============================================================================

export type {
  SessionRun,
  SessionRunStatus,
  CreateSessionRunParams,
  ClaimSessionRunParams,
  DueSessionRun,
} from "./session-runs.js";
export { SessionRunRepository } from "./session-runs.js";

// =============================================================================
// Session Tools
// =============================================================================

export type {
  SessionToolRef,
  SessionToolRefType,
  UpsertSessionToolRefParams,
} from "./session-tools.js";
export { SessionToolRepository } from "./session-tools.js";

// =============================================================================
// Containers
// =============================================================================

export type {
  ContainerRecord,
  ContainerSleepStatus,
  ContainerStatus,
  CreateContainerParams,
  LinkSessionContainerParams,
  SessionContainerLink,
  SessionContainerRole,
} from "./containers.js";
export { ContainerRepository } from "./containers.js";

// =============================================================================
// Auth
// =============================================================================

export type {
  AccessToken,
  AccessTokenListItem,
  CreateAccessTokenParams,
  ResolvedBearerAuthContext,
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
  AuthContextRepository,
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
