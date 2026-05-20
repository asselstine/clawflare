// Internal session types - session metadata, input queue, and runtime state
// These are used by the server but not exposed to clients

/**
 * Session status values
 */
export type SessionStatus =
  | "idle"
  | "processing"
  | "awaiting_input"
  | "error"
  | "closed"
  | "expired";

/**
 * Session metadata stored in Durable Object
 * Lightweight metadata without full message history
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
 * Input events that can be sent to a running session workflow
 */
export type SessionInputEvent =
  | { type: "prompt"; content: string; maxTurns?: number }
  | { type: "steer"; content: string }
  | { type: "fork"; parentId: string }
  | { type: "close" };

/**
 * Session input queue state
 */
export interface SessionEventQueue {
  pending: SessionInputEvent[];
  maxSize: number;
}

/**
 * Event metadata for storage management
 */
export interface EventMeta {
  nextSequence: number;
  oldestSequence: number;
  count: number;
}

/**
 * Storage error details when quota exceeded
 */
export interface StorageErrorDetails {
  requestedSize: number;
  limit: number;
  key: string;
  messageSize: number;
  messageCount: number;
  suggestedAction: string;
}

/**
 * Error class for storage quota errors
 */
export class StorageQuotaError extends Error {
  public readonly details: StorageErrorDetails;

  constructor(details: StorageErrorDetails) {
    super(`Storage quota exceeded: ${details.requestedSize} bytes exceeds ${details.limit} byte limit`);
    this.name = "StorageQuotaError";
    this.details = details;
  }
}

/**
 * Queue mode for steering/follow-up messages
 */
export type QueueMode = "all" | "one-at-a-time";

/**
 * Check size of a value before storage
 */
export function checkStorageSize(value: unknown, key: string, limit = 130000): void {
  const serialized = JSON.stringify(value);
  const size = new TextEncoder().encode(serialized).length;

  if (size > limit) {
    throw new StorageQuotaError({
      requestedSize: size,
      limit,
      key,
      messageSize: 0,
      messageCount: 0,
      suggestedAction: "Session has grown too large. Use /new or /clear",
    });
  }
}
