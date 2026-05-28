/**
 * Session Data Types
 * 
 * Domain types for session management.
 */

import type { ModelProvider } from "@clawflare/types";
import type { SessionEvent, SessionStatus } from "../types.js";

// Re-export from types for convenience
export type { SessionEvent, SessionStatus } from "../types.js";

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
  modelProvider?: ModelProvider;
  modelName?: string;
  workflowAuthJobId?: string;
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
  modelProvider?: ModelProvider;
  modelName?: string;
  workflowAuthJobId?: string;
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
