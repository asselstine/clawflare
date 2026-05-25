// Data layer interfaces - Repository pattern for Clawflare persistence
// These interfaces define the contract between the application and storage

import type { SessionEvent, SessionStatus } from "../types.js";

// Re-export for backwards compatibility
export type { SessionEvent, SessionStatus } from "../types.js";

// =============================================================================
// Workspace Types
// =============================================================================

/**
 * Workspace entity
 */
export interface Workspace {
  id: string;
  slug: string;
  name: string;
  description?: string;
  defaultModelConnectionId?: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * User entity
 */
export interface User {
  id: string;
  email: string;
  displayName?: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * Workspace membership role
 */
export type WorkspaceRole = "owner" | "admin" | "member" | "viewer";

/**
 * Workspace membership
 */
export interface WorkspaceMembership {
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
  joinedAt: number;
  updatedAt: number;
}

// =============================================================================
// Session Types
// =============================================================================

/**
 * Session metadata state - the core session record
 */
export interface SessionMetadataState {
  id: string;
  workspaceId: string;
  workflowId: string;
  status: SessionStatus;
  nextEventCursor: string;
  updatedAt: number;
  errorMessage?: string;
  maxQueueSize?: number;
  idleTimeout?: string;
  modelConnectionId?: string;
  modelProvider?: string;
  modelName?: string;
}

/**
 * Session summary for list views
 */
export interface SessionSummary {
  id: string;
  workspaceId: string;
  workflowId: string;
  status: SessionStatus;
  messageCount: number;
  updatedAt: number;
  isActive: boolean;
  modelConnectionId?: string;
  modelProvider?: string;
  modelName?: string;
}

/**
 * Filter for session listing
 */
export interface SessionListFilter {
  workspaceId: string;
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
 * Stored code entry - workspace scoped
 */
export interface StoredCodeEntry {
  workspaceId: string;
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
  workspaceId: string;
  name: string;
  code: string;
  description?: string;
  tags?: string[];
}

// =============================================================================
// Egress Handler Types
// =============================================================================

/**
 * Egress handler metadata - workspace scoped
 */
export interface EgressHandlerMetadata {
  workspaceId: string;
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
  workspaceId: string;
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

  /** Find session by ID - must belong to workspace */
  findById(sessionId: string): Promise<SessionMetadataState | null>;

  /** Find session by ID scoped to workspace */
  findByIdInWorkspace(workspaceId: string, sessionId: string): Promise<SessionMetadataState | null>;

  /** Mark session as failed with error message */
  markError(sessionId: string, message: string): Promise<void>;

  /** Mark session as closed */
  markClosed(
    sessionId: string,
    reason: "user" | "timeout" | "error"
  ): Promise<void>;

  /** List sessions with optional filtering - workspace scoped */
  list(filter: SessionListFilter): Promise<SessionSummary[]>;

  /** Count sessions matching filter - workspace scoped */
  count(filter: SessionListFilter): Promise<number>;
}

/**
 * Session event repository - manages event log
 */
export interface SessionEventRepository {
  /** Get the latest event cursor (sequence number as string) */
  latestCursor(sessionId: string): Promise<string>;

  /** Get event count for a session */
  count(sessionId: string): Promise<number>;

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

  /** List most recent events (descending order) */
  listRecent(
    sessionId: string,
    limit?: number
  ): Promise<SessionEvent[]>;

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
 * Stored code repository - manages reusable code, workspace scoped
 */
export interface StoredCodeRepository {
  /** Upsert a code entry in a workspace */
  upsert(params: UpsertStoredCodeParams): Promise<void>;

  /** Get code by name within a workspace */
  get(workspaceId: string, name: string): Promise<StoredCodeEntry | null>;

  /** List stored code entries in a workspace */
  list(workspaceId: string, limit?: number): Promise<StoredCodeEntry[]>;

  /** Search stored code within a workspace */
  search(workspaceId: string, query: string, limit: number): Promise<StoredCodeEntry[]>;
}

/**
 * Egress handler repository - manages egress handler metadata, workspace scoped
 */
export interface EgressHandlerRepository {
  /** Upsert an egress handler in a workspace */
  upsert(params: UpsertEgressHandlerParams): Promise<void>;

  /** Get handler by name within a workspace */
  get(workspaceId: string, name: string): Promise<EgressHandlerMetadata | null>;

  /** List egress handlers in a workspace */
  list(workspaceId: string, enabledOnly?: boolean): Promise<EgressHandlerMetadata[]>;

  /** Search egress handlers within a workspace */
  search(workspaceId: string, query: string, limit: number): Promise<EgressHandlerMetadata[]>;
}

/**
 * Workspace repository - manages workspaces and memberships
 */
export interface WorkspaceRepository {
  /** Get workspace by ID */
  getById(id: string): Promise<Workspace | null>;

  /** Get workspace by slug */
  getBySlug(slug: string): Promise<Workspace | null>;

  /** Create new workspace */
  create(workspace: Omit<Workspace, "createdAt" | "updatedAt">): Promise<Workspace>;

  /** List workspaces for a user */
  listForUser(userId: string): Promise<Workspace[]>;

  /** Check if user is member of workspace */
  isMember(workspaceId: string, userId: string): Promise<boolean>;

  /** Get user's role in workspace */
  getUserRole(workspaceId: string, userId: string): Promise<WorkspaceRole | null>;

  /** Add user to workspace */
  addMembership(membership: Omit<WorkspaceMembership, "joinedAt" | "updatedAt">): Promise<void>;

  /** Remove user from workspace */
  removeMembership(workspaceId: string, userId: string): Promise<void>;
}

/**
 * Search result type
 */
export interface SearchResults {
  storedCode: StoredCodeEntry[];
  egressHandlers: EgressHandlerMetadata[];
}

// =============================================================================
// Model Connection Types
// =============================================================================

/**
 * Model provider identifier
 */
export type ModelProvider = string;

/**
 * Model connection entity - workspace scoped AI model configuration
 */
export interface ModelConnection {
  id: string;
  workspaceId: string;
  displayName?: string;
  provider: ModelProvider;
  modelName: string;
  secretRefs: Record<string, string>;
  config: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;
}

/**
 * Parameters for creating a model connection
 */
export interface CreateModelConnectionParams {
  id?: string;
  workspaceId: string;
  displayName?: string;
  provider: string;
  modelName: string;
  secretRefs?: Record<string, string>;
  config?: Record<string, unknown>;
}

/**
 * Parameters for updating a model connection
 */
export interface UpdateModelConnectionParams {
  displayName?: string | null;
  provider?: string;
  modelName?: string;
  secretRefs?: Record<string, string>;
  config?: Record<string, unknown>;
}

/**
 * Model connection repository interface
 */
export interface ModelConnectionRepository {
  /** Create a new model connection */
  create(params: CreateModelConnectionParams): Promise<ModelConnection>;

  /** Get a model connection by ID - must belong to workspace */
  get(workspaceId: string, id: string): Promise<ModelConnection | null>;

  /** List all non-deleted model connections in a workspace */
  list(workspaceId: string): Promise<ModelConnection[]>;

  /** Update a model connection */
  update(workspaceId: string, id: string, params: UpdateModelConnectionParams): Promise<ModelConnection>;

  /** Soft-delete a model connection */
  softDelete(workspaceId: string, id: string): Promise<void>;

  /** Set workspace default model connection */
  setWorkspaceDefault(workspaceId: string, id: string | null): Promise<void>;

  /** Get workspace default model connection */
  getWorkspaceDefault(workspaceId: string): Promise<ModelConnection | null>;

  /** Count active sessions referencing this model connection */
  countActiveSessionReferences(workspaceId: string, id: string): Promise<number>;
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
  workspaces: WorkspaceRepository;
  snapshots: SnapshotRepository;
  modelConnections: ModelConnectionRepository;

  /** Search across stored code and egress handlers in a workspace */
  search(workspaceId: string, query: string, limit: number): Promise<SearchResults>;
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
  getStoredCode(workspaceId: string, name: string): Promise<StoredCodeEntry | null>;
  listEgressHandlers(workspaceId: string, enabledOnly: boolean): Promise<EgressHandlerMetadata[]>;
  search(workspaceId: string, query: string, limit: number): Promise<SearchResults>;
}
