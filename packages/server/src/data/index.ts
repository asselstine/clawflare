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
  SessionRepository,
  SessionEventRepository,
  InputQueueRepository,
} from "./sessions.js";

// =============================================================================
// Workspaces
// =============================================================================

export type {
  User,
  Workspace,
  WorkspaceRole,
  WorkspaceMembership,
  UserRepository,
  WorkspaceRepository,
} from "./workspaces.js";

// =============================================================================
// Stored Code
// =============================================================================

export type {
  StoredCodeEntry,
  UpsertStoredCodeParams,
  StoredCodeRepository,
} from "./stored-code.js";

// =============================================================================
// Egress Handlers
// =============================================================================

export type {
  EgressHandlerMetadata,
  UpsertEgressHandlerParams,
  EgressHandlerRepository,
} from "./egress-handlers.js";

// =============================================================================
// Model Connections
// =============================================================================

export type {
  ModelConnection,
  ModelProvider,
  CreateModelConnectionParams,
  UpdateModelConnectionParams,
  ModelConnectionRepository,
} from "./model-connections.js";

// =============================================================================
// Snapshots
// =============================================================================

export type {
  SessionRuntimeRepository,
  SnapshotRepository,
} from "./snapshots.js";

// =============================================================================
// Job Snapshots
// =============================================================================

export type { JobAuthorizationSnapshot, JobSnapshotRepository } from "./job-snapshots.js";
export { createJobSnapshot } from "./job-snapshots.js";

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
  AccessTokenRepository,
  WebSessionRepository,
  EmailVerificationTokenRepository,
  PasswordResetTokenRepository,
  DeviceAuthorizationRepository,
} from "./auth.js";

// =============================================================================
// Legacy Datastore (for compatibility)
// =============================================================================

export type { SearchResults, DataLayer, Datastore } from "./interfaces.js";

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

// =============================================================================
// D1 Data Layer
// =============================================================================

export {
  createD1DataLayer,
  D1SessionRepository,
  D1SessionEventRepository,
  D1InputQueueRepository,
  D1SessionRuntimeRepository,
  D1StoredCodeRepository,
  D1EgressHandlerRepository,
  D1SnapshotRepository,
  D1WorkspaceRepository,
  D1UserRepository,
  D1ModelConnectionRepository,
  D1JobSnapshotRepository,
  D1AccessTokenRepository,
  D1WebSessionRepository,
  D1EmailVerificationTokenRepository,
  D1PasswordResetTokenRepository,
  D1DeviceAuthorizationRepository,
} from "./d1/d1-data-layer.js";

export type { D1DataLayer } from "./d1/d1-data-layer.js";

// =============================================================================
// Row Mappers
// =============================================================================

export type {
  UserRow,
  WorkspaceRow,
  WorkspaceMembershipRow,
  SessionRow,
  SessionWithCountRow,
  SessionEventRow,
  QueueRow,
  RuntimeRow,
  StoredCodeRow,
  EgressHandlerRow,
  ModelConnectionRow,
} from "./d1/row-mappers.js";

export {
  mapUserRow,
  mapWorkspaceRow,
  mapWorkspaceMembershipRow,
  mapSessionRow,
  mapSessionSummaryRowWithCount,
  mapSessionEventRow,
  mapQueueRow,
  mapStoredCodeRow,
  mapEgressHandlerRow,
  mapRuntimeRow,
  mapModelConnectionRow,
} from "./d1/row-mappers.js";

// =============================================================================
// Factory Function
// =============================================================================

import type { Env } from "../internal-types/index.js";
import type { DataLayer } from "./interfaces.js";
import { createD1DataLayer, type D1DataLayer } from "./d1/d1-data-layer.js";

// =============================================================================
// Cached Data Layer Accessor
// =============================================================================

/**
 * Cached data layer per environment
 * This is the canonical way to get the data layer in route handlers
 */
const dataLayerCache = new WeakMap<Env, DataLayer>();

/**
 * Get or create the data layer for the given environment
 * Returns a cached instance if one exists
 */
export function getDataLayer(env: Env): D1DataLayer {
  let layer = dataLayerCache.get(env) as D1DataLayer | undefined;
  if (!layer) {
    layer = createDataLayer(env);
    dataLayerCache.set(env, layer);
  }
  return layer;
}

/**
 * Create the appropriate data layer based on environment configuration
 *
 * Uses D1 as the primary data layer.
 * Falls back to Durable Object storage only if DB binding is missing.
 */
export function createDataLayer(env: Env): D1DataLayer {
  // Check if D1 database is available
  if ((env as unknown as { DB?: D1Database }).DB) {
    return createD1DataLayer((env as unknown as { DB: D1Database }).DB);
  }

  // If no DB binding, throw an error - D1 is required
  throw new Error(
    "D1 database binding (DB) is required but not configured. " +
    "Please add a D1 database binding to wrangler.jsonc"
  );
}
