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

  // Repository interfaces
  SessionRepository,
  SessionEventRepository,
  InputQueueRepository,
  SessionRuntimeRepository,
  StoredCodeRepository,
  EgressHandlerRepository,
  SnapshotRepository,
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
} from "./d1/d1-data-layer.js";

// =============================================================================
// Row Mappers
// =============================================================================

export type {
  SessionRow,
  SessionEventRow,
  QueueRow,
  RuntimeRow,
  StoredCodeRow,
  EgressHandlerRow,
} from "./d1/row-mappers.js";

export {
  mapSessionRow,
  mapSessionSummaryRow,
  mapSessionEventRow,
  mapQueueRow,
  mapStoredCodeRow,
  mapEgressHandlerRow,
  mapRuntimeRow,
} from "./d1/row-mappers.js";

// =============================================================================
// Factory Function
// =============================================================================

import type { Env } from "../internal-types/index.js";
import type { DataLayer } from "./interfaces.js";
import { createD1DataLayer } from "./d1/d1-data-layer.js";

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
