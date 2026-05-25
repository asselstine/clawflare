// Row mappers for D1 queries
// Converts between D1 row results and TypeScript types

import type {
  SessionMetadataState,
  SessionSummary,
  StoredCodeEntry,
  EgressHandlerMetadata,
  Workspace,
  WorkspaceMembership,
  User,
  ModelConnection,
} from "../interfaces.js";
import type { SessionStatus, SessionEvent } from "../../types.js";

// =============================================================================
// D1 Row Types
// =============================================================================

export interface UserRow {
  id: string;
  email: string;
  display_name: string | null;
  created_at: number;
  updated_at: number;
}

export interface WorkspaceRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  created_at: number;
  updated_at: number;
  default_model_connection_id: string | null;
}

export interface WorkspaceMembershipRow {
  workspace_id: string;
  user_id: string;
  role: string;
  joined_at: number;
  updated_at: number;
}

export interface SessionRow {
  id: string;
  workspace_id: string;
  workflow_id: string;
  status: string;
  next_event_cursor: number;
  updated_at: number;
  error_message: string | null;
  max_queue_size: number;
  idle_timeout: string | null;
  model_connection_id: string | null;
  model_provider: string | null;
  model_name: string | null;
}

// Extended row type including event count from JOIN
export interface SessionWithCountRow extends SessionRow {
  event_count: number;
  active?: number;
}

export interface SessionEventRow {
  session_id: string;
  workspace_id: string | null;
  sequence: number;
  timestamp: number;
  type: string;
  payload_json: string;
}

export interface QueueRow {
  session_id: string;
  workspace_id: string | null;
  sequence: number;
  event_json: string;
  created_at: number;
}

// Runtime row type for storing workflow session and snapshot data
export interface RuntimeRow {
  session_id: string;
  workspace_id: string | null;
  active: number;
  workflow_session_json: string | null;
  snapshot_json: string | null;
  updated_at: number;
}

export interface StoredCodeRow {
  workspace_id: string;
  name: string;
  code: string;
  description: string | null;
  tags_json: string;
  created_at: number;
  updated_at: number;
}

export interface EgressHandlerRow {
  workspace_id: string;
  name: string;
  description: string;
  domains_json: string;
  enabled: number;
  config_json: string;
  updated_at: number;
}

// =============================================================================
// Model Connection Row Types
// =============================================================================

export interface ModelConnectionRow {
  id: string;
  workspace_id: string;
  display_name: string | null;
  provider: string;
  model_name: string;
  secret_refs_json: string;
  config_json: string;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

// =============================================================================
// User Mappers
// =============================================================================

export function mapUserRow(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// =============================================================================
// Workspace Mappers
// =============================================================================

export function mapWorkspaceRow(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description ?? undefined,
    defaultModelConnectionId: row.default_model_connection_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapWorkspaceMembershipRow(row: WorkspaceMembershipRow): WorkspaceMembership {
  return {
    workspaceId: row.workspace_id,
    userId: row.user_id,
    role: row.role as import("../interfaces.js").WorkspaceRole,
    joinedAt: row.joined_at,
    updatedAt: row.updated_at,
  };
}

// =============================================================================
// Session Mappers
// =============================================================================

export function mapSessionRow(row: SessionRow): SessionMetadataState {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    workflowId: row.workflow_id,
    status: row.status as SessionStatus,
    nextEventCursor: String(row.next_event_cursor),
    updatedAt: row.updated_at,
    errorMessage: row.error_message ?? undefined,
    maxQueueSize: row.max_queue_size,
    idleTimeout: row.idle_timeout ?? undefined,
    modelConnectionId: row.model_connection_id ?? undefined,
    modelProvider: row.model_provider ?? undefined,
    modelName: row.model_name ?? undefined,
  };
}

export function mapSessionSummaryRow(row: SessionRow): SessionSummary {
  const status = row.status as SessionStatus;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
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
    workspaceId: row.workspace_id,
    workflowId: row.workflow_id,
    status,
    messageCount: row.event_count ?? 0,
    updatedAt: row.updated_at,
    isActive: row.active !== undefined ? Boolean(row.active) : status === "idle" || status === "processing",
    modelConnectionId: row.model_connection_id ?? undefined,
    modelProvider: row.model_provider ?? undefined,
    modelName: row.model_name ?? undefined,
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
    workspaceId: row.workspace_id,
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
    workspaceId: row.workspace_id,
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

// =============================================================================
// Model Connection Mappers
// =============================================================================

/**
 * Safe JSON parser - returns default value on error
 */
function safeJsonParse<T>(json: string, defaultValue: T): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    return defaultValue;
  }
}

export function mapModelConnectionRow(row: ModelConnectionRow): ModelConnection {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    displayName: row.display_name ?? undefined,
    provider: row.provider,
    modelName: row.model_name,
    secretRefs: safeJsonParse(row.secret_refs_json, {}),
    config: safeJsonParse(row.config_json, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at ?? undefined,
  };
}
