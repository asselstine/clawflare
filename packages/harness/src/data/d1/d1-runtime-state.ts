// D1 Session Runtime Repository Implementation
import type {
  SessionRuntimeRepository,
} from "../interfaces.js";

export class D1SessionRuntimeRepository implements SessionRuntimeRepository {
  constructor(private readonly db: D1Database) {}

  async getWorkflowId(sessionId: string): Promise<string | null> {
    // Workflow ID is stored in sessions table
    const row = await this.db
      .prepare(`SELECT workflow_id FROM sessions WHERE id = ?`)
      .bind(sessionId)
      .first<{ workflow_id: string }>();

    return row?.workflow_id ?? null;
  }

  async saveWorkflowId(sessionId: string, workflowId: string): Promise<void> {
    const now = Date.now();

    await this.db
      .prepare(
        `
        UPDATE sessions
        SET workflow_id = ?, updated_at = ?
        WHERE id = ?
      `
      )
      .bind(workflowId, now, sessionId)
      .run();
  }

  async isActive(sessionId: string): Promise<boolean> {
    const row = await this.db
      .prepare(`SELECT active FROM session_runtime WHERE session_id = ?`)
      .bind(sessionId)
      .first<{ active: number }>();

    return row ? Boolean(row.active) : false;
  }

  async setActive(sessionId: string, active: boolean): Promise<void> {
    const now = Date.now();

    await this.db
      .prepare(
        `
        INSERT INTO session_runtime (session_id, active, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          active = excluded.active,
          updated_at = excluded.updated_at
      `
      )
      .bind(sessionId, active ? 1 : 0, now)
      .run();
  }

  async getWorkflowSession(sessionId: string): Promise<unknown | null> {
    const row = await this.db
      .prepare(
        `SELECT workflow_session_json FROM session_runtime WHERE session_id = ?`
      )
      .bind(sessionId)
      .first<{ workflow_session_json: string | null }>();

    return row?.workflow_session_json
      ? (JSON.parse(row.workflow_session_json) as unknown)
      : null;
  }

  async saveWorkflowSession(
    sessionId: string,
    session: unknown
  ): Promise<void> {
    const now = Date.now();

    await this.db
      .prepare(
        `
        INSERT INTO session_runtime (session_id, workflow_session_json, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          workflow_session_json = excluded.workflow_session_json,
          updated_at = excluded.updated_at
      `
      )
      .bind(sessionId, JSON.stringify(session), now)
      .run();
  }

  async getSnapshot(sessionId: string): Promise<unknown | null> {
    const row = await this.db
      .prepare(
        `SELECT snapshot_json FROM session_runtime WHERE session_id = ?`
      )
      .bind(sessionId)
      .first<{ snapshot_json: string | null }>();

    return row?.snapshot_json
      ? (JSON.parse(row.snapshot_json) as unknown)
      : null;
  }

  async saveSnapshot(sessionId: string, snapshot: unknown): Promise<void> {
    const now = Date.now();

    await this.db
      .prepare(
        `
        INSERT INTO session_runtime (session_id, snapshot_json, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          snapshot_json = excluded.snapshot_json,
          updated_at = excluded.updated_at
      `
      )
      .bind(sessionId, JSON.stringify(snapshot), now)
      .run();
  }
}
