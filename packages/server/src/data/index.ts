// Data layer exports
// This is the primary entry point for the Clawflare data layer

// =============================================================================
// Interfaces - The contracts
// =============================================================================

export type {
  // Session types
  SessionMetadataState,
  SessionSummary,
  SessionListFilter,
  SessionStatus,

  // Event types
  NewSessionEvent,
  CompleteSessionEvent,

  // Queue types
  SessionInputEvent,
  QueueStatus,
  EnqueueResult,
  DequeueResult,

  // Stored code types
  StoredCodeEntry,
  UpsertStoredCodeParams,

  // Egress handler types
  EgressHandlerMetadata,
  UpsertEgressHandlerParams,
  SearchResults,

  // User/Workspace types
  Workspace,
  User,
  WorkspaceMembership,
  WorkspaceRole,

  // Model connection types
  ModelConnection,
  ModelProvider,
  CreateModelConnectionParams,
  UpdateModelConnectionParams,
  ModelConnectionRepository,

  // Repository interfaces
  SessionRepository,
  SessionEventRepository,
  InputQueueRepository,
  SessionRuntimeRepository,
  StoredCodeRepository,
  EgressHandlerRepository,
  SnapshotRepository,
  WorkspaceRepository,
  DataLayer,
  Datastore,
} from "./interfaces.js";

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
  D1ModelConnectionRepository,
} from "./d1/d1-data-layer.js";

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
import { createD1DataLayer } from "./d1/d1-data-layer.js";

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
export function getDataLayer(env: Env): DataLayer {
  let layer = dataLayerCache.get(env);
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
export function createDataLayer(env: Env): DataLayer {
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
