// D1 Session Repository Implementation
// Workspace-scoped for multi-tenant data access

import type {
  SessionRepository,
  SessionMetadataState,
  SessionSummary,
  SessionListFilter,
} from "../interfaces.js";
import type { SessionStatus } from "../../types.js";
import type { SessionRow } from "./row-mappers.js";
import { mapSessionRow, mapSessionSummaryRowWithCount } from "./row-mappers.js";

// Extended row type including event count from JOIN
interface SessionWithCountRowExt extends SessionRow {
  event_count: number;
  active?: number;
}

export class D1SessionRepository implements SessionRepository {
  constructor(private readonly db: D1Database) {}

  async save(session: SessionMetadataState): Promise<void> {
    const now = Date.now();

    await this.db
      .prepare(
        `
        INSERT INTO sessions (
          id, workspace_id, workflow_id, status, next_event_cursor,
          updated_at, error_message, max_queue_size, idle_timeout
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          workspace_id = excluded.workspace_id,
          workflow_id = excluded.workflow_id,
          status = excluded.status,
          next_event_cursor = excluded.next_event_cursor,
          updated_at = excluded.updated_at,
          error_message = excluded.error_message,
          max_queue_size = excluded.max_queue_size,
          idle_timeout = excluded.idle_timeout
      `
      )
      .bind(
        session.id,
        session.workspaceId,
        session.workflowId,
        session.status,
        Number(session.nextEventCursor || 0),
        session.updatedAt || now,
        session.errorMessage ?? null,
        session.maxQueueSize ?? 100,
        session.idleTimeout ?? null
      )
      .run();

    await this.db
      .prepare(
        `
        INSERT INTO session_counters (
          session_id, workspace_id, next_queue_sequence, next_event_sequence, updated_at
        )
        VALUES (?, ?, 1, 1, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          workspace_id = excluded.workspace_id,
          updated_at = excluded.updated_at
      `
      )
      .bind(session.id, session.workspaceId, session.updatedAt || now)
      .run();
  }

  async findById(sessionId: string): Promise<SessionMetadataState | null> {
    const row = await this.db
      .prepare(
        `
        SELECT 
          id, workspace_id, workflow_id, status, next_event_cursor,
          updated_at, error_message, max_queue_size, idle_timeout
        FROM sessions
        WHERE id = ?
      `
      )
      .bind(sessionId)
      .first<SessionRow>();

    return row ? mapSessionRow(row) : null;
  }

  async findByIdInWorkspace(
    workspaceId: string,
    sessionId: string
  ): Promise<SessionMetadataState | null> {
    const row = await this.db
      .prepare(
        `
        SELECT 
          id, workspace_id, workflow_id, status, next_event_cursor,
          updated_at, error_message, max_queue_size, idle_timeout
        FROM sessions
        WHERE id = ? AND workspace_id = ?
      `
      )
      .bind(sessionId, workspaceId)
      .first<SessionRow>();

    return row ? mapSessionRow(row) : null;
  }

  async markError(sessionId: string, message: string): Promise<void> {
    const now = Date.now();

    await this.db
      .prepare(
        `
        UPDATE sessions
        SET status = 'error', error_message = ?, updated_at = ?
        WHERE id = ?
      `
      )
      .bind(message, now, sessionId)
      .run();
  }

  async markClosed(
    sessionId: string,
    reason: "user" | "timeout" | "error"
  ): Promise<void> {
    const status: SessionStatus =
      reason === "timeout" ? "expired" : "closed";
    const now = Date.now();

    await this.db
      .prepare(
        `
        UPDATE sessions
        SET status = ?, updated_at = ?
        WHERE id = ?
      `
      )
      .bind(status, now, sessionId)
      .run();

    // Also mark runtime as inactive
    await this.db
      .prepare(
        `
        UPDATE session_runtime
        SET active = 0, updated_at = ?
        WHERE session_id = ?
      `
      )
      .bind(now, sessionId)
      .run();
  }

  async list(filter: SessionListFilter): Promise<SessionSummary[]> {
    const limit = Math.min(filter.limit ?? 50, 100);
    const offset = filter.offset ?? 0;
    const workspaceId = filter.workspaceId;

    // Single query with JOIN to get event counts efficiently
    let query: string;
    let bindings: (string | number)[];

    if (filter.status && filter.status !== "all") {
      query = `
        SELECT 
          s.id, s.workspace_id, s.workflow_id, s.status, s.next_event_cursor,
          s.updated_at, s.error_message, s.max_queue_size, s.idle_timeout,
          COUNT(e.sequence) AS event_count,
          COALESCE(MAX(r.active), 0) AS active
        FROM sessions s
        LEFT JOIN session_events e ON e.session_id = s.id
        LEFT JOIN session_runtime r ON r.session_id = s.id
        WHERE s.workspace_id = ? AND s.status = ?
        GROUP BY s.id
        ORDER BY s.updated_at DESC
        LIMIT ? OFFSET ?
      `;
      bindings = [workspaceId, filter.status, limit, offset];
    } else {
      query = `
        SELECT 
          s.id, s.workspace_id, s.workflow_id, s.status, s.next_event_cursor,
          s.updated_at, s.error_message, s.max_queue_size, s.idle_timeout,
          COUNT(e.sequence) AS event_count,
          COALESCE(MAX(r.active), 0) AS active
        FROM sessions s
        LEFT JOIN session_events e ON e.session_id = s.id
        LEFT JOIN session_runtime r ON r.session_id = s.id
        WHERE s.workspace_id = ?
        GROUP BY s.id
        ORDER BY s.updated_at DESC
        LIMIT ? OFFSET ?
      `;
      bindings = [workspaceId, limit, offset];
    }

    const result = await this.db.prepare(query).bind(...bindings).all<SessionWithCountRowExt>();

    return result.results.map(mapSessionSummaryRowWithCount);
  }

  async count(filter: SessionListFilter): Promise<number> {
    let query: string;
    let bindings: (string | number)[];

    if (filter.status && filter.status !== "all") {
      query = `SELECT COUNT(*) as count FROM sessions WHERE workspace_id = ? AND status = ?`;
      bindings = [filter.workspaceId, filter.status];
    } else {
      query = `SELECT COUNT(*) as count FROM sessions WHERE workspace_id = ?`;
      bindings = [filter.workspaceId];
    }

    const result = await this.db
      .prepare(query)
      .bind(...bindings)
      .first<{ count: number }>();

    return result?.count ?? 0;
  }
}
