// D1 Input Queue Repository Implementation
import type {
  InputQueueRepository,
  QueueStatus,
  SessionInputEvent,
  EnqueueResult,
  DequeueResult,
} from "../interfaces.js";

const DEFAULT_MAX_QUEUE_SIZE = 100;

export class D1InputQueueRepository implements InputQueueRepository {
  constructor(private readonly db: D1Database) {}

  async status(sessionId: string): Promise<QueueStatus> {
    const result = await this.db
      .prepare(
        `
        SELECT event_json
        FROM session_input_queue
        WHERE session_id = ?
        ORDER BY sequence ASC
        LIMIT ${DEFAULT_MAX_QUEUE_SIZE}
      `
      )
      .bind(sessionId)
      .all<{ event_json: string }>();

    const events = result.results.map(
      (row) => JSON.parse(row.event_json) as SessionInputEvent
    );

    return {
      pending: events.length,
      max: DEFAULT_MAX_QUEUE_SIZE,
      events,
    };
  }

  async enqueue(
    sessionId: string,
    event: SessionInputEvent
  ): Promise<EnqueueResult> {
    const queue = await this.status(sessionId);

    if (queue.pending >= queue.max) {
      return {
        ok: false,
        queued: queue.pending,
        error: "Queue full",
      };
    }

    // Get next sequence
    const row = await this.db
      .prepare(
        `
        SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence
        FROM session_input_queue
        WHERE session_id = ?
      `
      )
      .bind(sessionId)
      .first<{ next_sequence: number }>();

    await this.db
      .prepare(
        `
        INSERT INTO session_input_queue (
          session_id, sequence, event_json, created_at
        )
        VALUES (?, ?, ?, ?)
      `
      )
      .bind(
        sessionId,
        row?.next_sequence ?? 1,
        JSON.stringify(event),
        Date.now()
      )
      .run();

    return {
      ok: true,
      queued: queue.pending + 1,
    };
  }

  async dequeue(sessionId: string): Promise<DequeueResult> {
    const row = await this.db
      .prepare(
        `
        SELECT sequence, event_json
        FROM session_input_queue
        WHERE session_id = ?
        ORDER BY sequence ASC
        LIMIT 1
      `
      )
      .bind(sessionId)
      .first<{ sequence: number; event_json: string }>();

    if (!row) {
      return {
        event: null,
        remaining: 0,
      };
    }

    // Delete the row
    await this.db
      .prepare(
        `
        DELETE FROM session_input_queue
        WHERE session_id = ? AND sequence = ?
      `
      )
      .bind(sessionId, row.sequence)
      .run();

    // Count remaining
    const remainingRow = await this.db
      .prepare(
        `
        SELECT COUNT(*) AS count
        FROM session_input_queue
        WHERE session_id = ?
      `
      )
      .bind(sessionId)
      .first<{ count: number }>();

    return {
      event: JSON.parse(row.event_json) as SessionInputEvent,
      remaining: remainingRow?.count ?? 0,
    };
  }
}