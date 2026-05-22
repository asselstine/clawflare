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

    const now = Date.now();

    // Reserve a unique sequence number. The session coordinator serializes
    // normal application traffic, and this counter also prevents duplicate
    // sequence numbers if the repository is called directly.
    const row = await this.db
      .prepare(
        `
        INSERT INTO session_counters (
          session_id, next_queue_sequence, next_event_sequence, updated_at
        )
        VALUES (?, 2, 1, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          next_queue_sequence = next_queue_sequence + 1,
          updated_at = excluded.updated_at
        RETURNING next_queue_sequence - 1 AS sequence
      `
      )
      .bind(sessionId, now)
      .first<{ sequence: number }>();

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
        row?.sequence ?? 1,
        JSON.stringify(event),
        now
      )
      .run();

    return {
      ok: true,
      queued: queue.pending + 1,
    };
  }

  async dequeue(sessionId: string): Promise<DequeueResult> {
    // Atomically remove and return the first queued event. This prevents two
    // direct repository callers from observing the same queue row.
    const row = await this.db
      .prepare(
        `
        DELETE FROM session_input_queue
        WHERE session_id = ?
          AND sequence = (
            SELECT sequence
            FROM session_input_queue
            WHERE session_id = ?
            ORDER BY sequence ASC
            LIMIT 1
          )
        RETURNING event_json
      `
      )
      .bind(sessionId, sessionId)
      .first<{ event_json: string }>();

    if (!row) {
      return {
        event: null,
        remaining: 0,
      };
    }

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