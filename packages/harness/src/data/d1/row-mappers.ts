// Row mappers for D1 queries
// Converts between D1 row results and TypeScript types

import type {
  SessionMetadataState,
  SessionSummary,
  StoredCodeEntry,
  EgressHandlerMetadata,
} from "../interfaces.js";
import type { SessionStatus, SessionEvent } from "../../types.js";

// =============================================================================
// D1 Row Types
// =============================================================================

export interface SessionRow {
  id: string;
  workflow_id: string;
  status: string;
  next_event_cursor: number;
  updated_at: number;
  error_message: string | null;
  max_queue_size: number;
  idle_timeout: string | null;
}

// Extended row type including event count from JOIN
export interface SessionWithCountRow extends SessionRow {
  event_count: number;
  active?: number;
}

export interface SessionEventRow {
  session_id: string;
  sequence: number;
  timestamp: number;
  type: string;
  payload_json: string;
}

export interface QueueRow {
  session_id: string;
  sequence: number;
  event_json: string;
  created_at: number;
}

// Runtime row type for storing workflow session and snapshot data
export interface RuntimeRow {
  session_id: string;
  active: number;
  workflow_session_json: string | null;
  snapshot_json: string | null;
  updated_at: number;
}

export interface StoredCodeRow {
  name: string;
  code: string;
  description: string | null;
  tags_json: string;
  created_at: number;
  updated_at: number;
}

export interface EgressHandlerRow {
  name: string;
  description: string;
  domains_json: string;
  enabled: number;
  config_json: string;
  updated_at: number;
}

// =============================================================================
// Session Mappers
// =============================================================================

export function mapSessionRow(row: SessionRow): SessionMetadataState {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    status: row.status as SessionStatus,
    nextEventCursor: String(row.next_event_cursor),
    updatedAt: row.updated_at,
    errorMessage: row.error_message ?? undefined,
    maxQueueSize: row.max_queue_size,
    idleTimeout: row.idle_timeout ?? undefined,
  };
}

export function mapSessionSummaryRow(row: SessionRow): SessionSummary {
  const status = row.status as SessionStatus;
  return {
    id: row.id,
    workflowId: row.workflow_id,
    status,
    messageCount: 0, // Will need to query events for this
    updatedAt: row.updated_at,
    isActive: status === "idle" || status === "processing",
  };
}

export function mapSessionSummaryRowWithCount(row: SessionWithCountRow): SessionSummary {
  const status = row.status as SessionStatus;
  return {
    id: row.id,
    workflowId: row.workflow_id,
    status,
    messageCount: row.event_count ?? 0,
    updatedAt: row.updated_at,
    isActive: row.active !== undefined ? Boolean(row.active) : status === "idle" || status === "processing",
  };
}

// =============================================================================
// Event Mappers
// =============================================================================

export function mapSessionEventRow(row: SessionEventRow): SessionEvent {
  const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
  return {
    ...payload,
    sequence: row.sequence,
    timestamp: row.timestamp,
  } as SessionEvent;
}

// =============================================================================
// Queue Mappers
// =============================================================================

export function mapQueueRow(row: QueueRow): { type: string; content?: string; maxTurns?: number } & Record<string, unknown> {
  return JSON.parse(row.event_json) as { type: string; content?: string; maxTurns?: number } & Record<string, unknown>;
}

// =============================================================================
// Stored Code Mappers
// =============================================================================

export function mapStoredCodeRow(row: StoredCodeRow): StoredCodeEntry {
  return {
    name: row.name,
    code: row.code,
    description: row.description ?? undefined,
    tags: JSON.parse(row.tags_json) as string[],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// =============================================================================
// Egress Handler Mappers
// =============================================================================

export function mapEgressHandlerRow(row: EgressHandlerRow): EgressHandlerMetadata {
  return {
    name: row.name,
    description: row.description,
    domains: JSON.parse(row.domains_json) as string[],
    enabled: Boolean(row.enabled),
    config: JSON.parse(row.config_json) as unknown,
    updatedAt: row.updated_at,
  };
}

// =============================================================================
// Runtime Mappers
// =============================================================================

export function mapRuntimeRow(row: RuntimeRow): {
  active: boolean;
  workflowSession: unknown | null;
  snapshot: unknown | null;
  updatedAt: number;
} {
  return {
    active: Boolean(row.active),
    workflowSession: row.workflow_session_json ? (JSON.parse(row.workflow_session_json) as unknown) : null,
    snapshot: row.snapshot_json ? (JSON.parse(row.snapshot_json) as unknown) : null,
    updatedAt: row.updated_at,
  };
}
