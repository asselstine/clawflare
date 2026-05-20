// Data layer interfaces - Repository pattern for Clawflare persistence
// These interfaces define the contract between the application and storage

import type { SessionEvent, SessionStatus } from "../types.js";

// Re-export for backwards compatibility
export type { SessionEvent, SessionStatus } from "../types.js";

// =============================================================================
// Session Types
// =============================================================================

/**
 * Session metadata state - the core session record
 */
export interface SessionMetadataState {
  id: string;
  workflowId: string;
  status: SessionStatus;
  nextEventCursor: string;
  updatedAt: number;
  errorMessage?: string;
  maxQueueSize?: number;
  idleTimeout?: string;
}

/**
 * Session summary for list views
 */
export interface SessionSummary {
  id: string;
  workflowId: string;
  status: SessionStatus;
  messageCount: number;
  updatedAt: number;
  isActive: boolean;
}

/**
 * Filter for session listing
 */
export interface SessionListFilter {
  status?: SessionStatus | "all";
  limit?: number;
  offset?: number;
  updatedAfter?: number;
  updatedBefore?: number;
}

// =============================================================================
// Event Types
// =============================================================================

/**
 * New session event before sequence assignment
 */
export interface NewSessionEvent {
  type: string;
  timestamp: number;
  [key: string]: unknown;
}

/**
 * Complete session event with sequence
 */
export interface CompleteSessionEvent extends NewSessionEvent {
  sequence: number;
}

// =============================================================================
// Input Queue Types
// =============================================================================

/**
 * Input events that can be sent to a running session workflow
 */
export type SessionInputEvent =
  | { type: "prompt"; content: string; maxTurns?: number }
  | { type: "steer"; content: string }
  | { type: "fork"; parentId: string }
  | { type: "close" };

/**
 * Queue status response
 */
export interface QueueStatus {
  pending: number;
  max: number;
  events: SessionInputEvent[];
}

/**
 * Enqueue result
 */
export interface EnqueueResult {
  ok: boolean;
  queued: number;
  error?: string;
}

/**
 * Dequeue result
 */
export interface DequeueResult {
  event: SessionInputEvent | null;
  remaining: number;
}

// =============================================================================
// Stored Code Types
// =============================================================================

/**
 * Stored code entry
 */
export interface StoredCodeEntry {
  name: string;
  code: string;
  description?: string;
  tags?: string[];
  createdAt: number;
  updatedAt: number;
}

/**
 * Parameters for upserting stored code
 */
export interface UpsertStoredCodeParams {
  name: string;
  code: string;
  description?: string;
  tags?: string[];
}

// =============================================================================
// Egress Handler Types
// =============================================================================

/**
 * Egress handler metadata
 */
export interface EgressHandlerMetadata {
  name: string;
  description: string;
  domains: string[];
  enabled: boolean;
  config: unknown;
  updatedAt: number;
}

/**
 * Parameters for upserting egress handler
 */
export interface UpsertEgressHandlerParams {
  name: string;
  description: string;
  domains: string[];
  enabled?: boolean;
  config?: unknown;
}

// =============================================================================
// Repository Interfaces
// =============================================================================

/**
 * Session repository - manages session metadata
 */
export interface SessionRepository {
  /** Save or update session metadata */
  save(session: SessionMetadataState): Promise<void>;

  /** Find session by ID */
  findById(sessionId: string): Promise<SessionMetadataState | null>;

  /** Mark session as failed with error message */
  markError(sessionId: string, message: string): Promise<void>;

  /** Mark session as closed */
  markClosed(
    sessionId: string,
    reason: "user" | "timeout" | "error"
  ): Promise<void>;

  /** List sessions with optional filtering */
  list(filter: SessionListFilter): Promise<SessionSummary[]>;

  /** Count sessions matching filter */
  count(filter: SessionListFilter): Promise<number>;
}

/**
 * Session event repository - manages event log
 */
export interface SessionEventRepository {
  /** Get the latest event cursor (sequence number as string) */
  latestCursor(sessionId: string): Promise<string>;

  /** Append events to the session's event log */
  append(
    sessionId: string,
    events: NewSessionEvent[]
  ): Promise<{ nextCursor: string }>;

  /** List events since a cursor */
  listSince(
    sessionId: string,
    sinceCursor?: string,
    limit?: number
  ): Promise<{ events: SessionEvent[]; nextCursor: string }>;

  /** Trim old events to keep within limit */
  trim(sessionId: string, maxEvents: number): Promise<void>;
}

/**
 * Input queue repository - manages session input queue
 */
export interface InputQueueRepository {
  /** Get queue status */
  status(sessionId: string): Promise<QueueStatus>;

  /** Enqueue an input event */
  enqueue(sessionId: string, event: SessionInputEvent): Promise<EnqueueResult>;

  /** Dequeue the next input event */
  dequeue(sessionId: string): Promise<DequeueResult>;
}

/**
 * Session runtime repository - manages workflow state and active flags
 */
export interface SessionRuntimeRepository {
  /** Get workflow ID for a session */
  getWorkflowId(sessionId: string): Promise<string | null>;

  /** Save workflow ID for a session */
  saveWorkflowId(sessionId: string, workflowId: string): Promise<void>;

  /** Check if session is currently active */
  isActive(sessionId: string): Promise<boolean>;

  /** Set session active status */
  setActive(sessionId: string, active: boolean): Promise<void>;

  /** Get workflow session snapshot */
  getWorkflowSession(sessionId: string): Promise<unknown | null>;

  /** Save workflow session snapshot */
  saveWorkflowSession(sessionId: string, session: unknown): Promise<void>;

  /** Get agent snapshot */
  getSnapshot(sessionId: string): Promise<unknown | null>;

  /** Save agent snapshot */
  saveSnapshot(sessionId: string, snapshot: unknown): Promise<void>;
}

/**
 * Stored code repository - manages reusable code
 */
export interface StoredCodeRepository {
  /** Upsert a code entry */
  upsert(entry: UpsertStoredCodeParams): Promise<void>;

  /** Get code by name */
  get(name: string): Promise<StoredCodeEntry | null>;

  /** List stored code entries */
  list(limit?: number): Promise<StoredCodeEntry[]>;

  /** Search stored code */
  search(query: string, limit: number): Promise<StoredCodeEntry[]>;
}

/**
 * Egress handler repository - manages egress handler metadata
 */
export interface EgressHandlerRepository {
  /** Upsert an egress handler */
  upsert(entry: UpsertEgressHandlerParams): Promise<void>;

  /** Get handler by name */
  get(name: string): Promise<EgressHandlerMetadata | null>;

  /** List egress handlers */
  list(enabledOnly?: boolean): Promise<EgressHandlerMetadata[]>;

  /** Search egress handlers */
  search(query: string, limit: number): Promise<EgressHandlerMetadata[]>;
}

/**
 * Search result type
 */
export interface SearchResults {
  storedCode: StoredCodeEntry[];
  egressHandlers: EgressHandlerMetadata[];
}

/**
 * Snapshot repository - manages agent snapshots
 */
export interface SnapshotRepository {
  /** Save a snapshot */
  save(sessionId: string, snapshot: unknown): Promise<void>;

  /** Get a snapshot */
  get(sessionId: string): Promise<unknown | null>;

  /** Delete a snapshot */
  delete(sessionId: string): Promise<void>;
}

// =============================================================================
// Data Layer Factory
// =============================================================================

/**
 * The complete data layer interface
 */
export interface DataLayer {
  sessions: SessionRepository;
  events: SessionEventRepository;
  inputQueue: InputQueueRepository;
  runtime: SessionRuntimeRepository;
  storedCode: StoredCodeRepository;
  egressHandlers: EgressHandlerRepository;
  snapshots: SnapshotRepository;

  /** Search across all collections */
  search(query: string, limit: number): Promise<SearchResults>;
}

// =============================================================================
// Legacy Datastore Interface (for compatibility)
// =============================================================================

/**
 * Legacy datastore interface - maintained for backwards compatibility
 * during migration. New code should use DataLayer directly.
 */
export interface Datastore {
  upsertStoredCode(entry: UpsertStoredCodeParams): Promise<void>;
  getStoredCode(name: string): Promise<StoredCodeEntry | null>;
  listEgressHandlers(enabledOnly: boolean): Promise<EgressHandlerMetadata[]>;
  search(collection: string, query: string, limit: number): Promise<SearchResults>;
}
