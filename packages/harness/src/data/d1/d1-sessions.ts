// D1 Session Repository Implementation
import type {
  SessionRepository,
  SessionMetadataState,
  SessionSummary,
  SessionListFilter,
} from "../interfaces.js";
import type { SessionStatus } from "../../types.js";
import type { SessionRow } from "./row-mappers.js";
import { mapSessionRow, mapSessionSummaryRow } from "./row-mappers.js";

export class D1SessionRepository implements SessionRepository {
  constructor(private readonly db: D1Database) {}

  async save(session: SessionMetadataState): Promise<void> {
    const now = Date.now();

    await this.db
      .prepare(
        `
        INSERT INTO sessions (
          id, workflow_id, status, next_event_cursor,
          updated_at, error_message, max_queue_size, idle_timeout
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
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
        session.workflowId,
        session.status,
        Number(session.nextEventCursor || 0),
        session.updatedAt || now,
        session.errorMessage ?? null,
        session.maxQueueSize ?? 100,
        session.idleTimeout ?? null
      )
      .run();
  }

  async findById(sessionId: string): Promise<SessionMetadataState | null> {
    const row = await this.db
      .prepare(
        `
        SELECT 
          id, workflow_id, status, next_event_cursor,
          updated_at, error_message, max_queue_size, idle_timeout
        FROM sessions
        WHERE id = ?
      `
      )
      .bind(sessionId)
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

    let query: string;
    let bindings: (string | number)[];

    if (filter.status && filter.status !== "all") {
      query = `
        SELECT 
          id, workflow_id, status, next_event_cursor,
          updated_at, error_message, max_queue_size, idle_timeout
        FROM sessions
        WHERE status = ?
        ORDER BY updated_at DESC
        LIMIT ? OFFSET ?
      `;
      bindings = [filter.status, limit, offset];
    } else {
      query = `
        SELECT 
          id, workflow_id, status, next_event_cursor,
          updated_at, error_message, max_queue_size, idle_timeout
        FROM sessions
        ORDER BY updated_at DESC
        LIMIT ? OFFSET ?
      `;
      bindings = [limit, offset];
    }

    const result = await this.db.prepare(query).bind(...bindings).all<SessionRow>();

    // Get event counts for each session
    const summaries: SessionSummary[] = [];
    for (const row of result.results) {
      const summary = mapSessionSummaryRow(row);
      // Count events for this session
      const countResult = await this.db
        .prepare(`SELECT COUNT(*) as count FROM session_events WHERE session_id = ?`)
        .bind(row.id)
        .first<{ count: number }>();
      summary.messageCount = countResult?.count ?? 0;
      summaries.push(summary);
    }

    return summaries;
  }

  async count(filter: SessionListFilter): Promise<number> {
    let query: string;
    let bindings: (string | number)[];

    if (filter.status && filter.status !== "all") {
      query = `SELECT COUNT(*) as count FROM sessions WHERE status = ?`;
      bindings = [filter.status];
    } else {
      query = `SELECT COUNT(*) as count FROM sessions`;
      bindings = [];
    }

    const result = await this.db
      .prepare(query)
      .bind(...bindings)
      .first<{ count: number }>();

    return result?.count ?? 0;
  }
}
