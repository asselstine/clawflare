// D1 Snapshot Repository Implementation
import type {
  SnapshotRepository,
} from "../interfaces.js";

export class D1SnapshotRepository implements SnapshotRepository {
  constructor(private readonly db: D1Database) {}

  async save(sessionId: string, snapshot: unknown): Promise<void> {
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

  async get(sessionId: string): Promise<unknown | null> {
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

  async delete(sessionId: string): Promise<void> {
    await this.db
      .prepare(
        `
        UPDATE session_runtime
        SET snapshot_json = NULL, updated_at = ?
        WHERE session_id = ?
      `
      )
      .bind(Date.now(), sessionId)
      .run();
  }
}
