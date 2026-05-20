// D1 Session Event Repository Implementation
import type {
  SessionEventRepository,
  NewSessionEvent,
} from "../interfaces.js";
import type { SessionEvent } from "../../types.js";
import type { SessionEventRow } from "./row-mappers.js";
import { mapSessionEventRow } from "./row-mappers.js";

export class D1SessionEventRepository implements SessionEventRepository {
  constructor(private readonly db: D1Database) {}

  async latestCursor(sessionId: string): Promise<string> {
    const row = await this.db
      .prepare(
        `
        SELECT COALESCE(MAX(sequence), 0) AS cursor
        FROM session_events
        WHERE session_id = ?
      `
      )
      .bind(sessionId)
      .first<{ cursor: number }>();

    return String(row?.cursor ?? 0);
  }

  async append(
    sessionId: string,
    newEvents: NewSessionEvent[]
  ): Promise<{ nextCursor: string }> {
    if (newEvents.length === 0) {
      return { nextCursor: await this.latestCursor(sessionId) };
    }

    const now = Date.now();

    // Reserve a contiguous block of event sequence numbers. The session
    // coordinator serializes normal application traffic, and this counter also
    // prevents duplicate sequence numbers if the repository is called directly.
    const cursorRow = await this.db
      .prepare(
        `
        INSERT INTO session_counters (
          session_id, next_queue_sequence, next_event_sequence, updated_at
        )
        VALUES (?, 1, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          next_event_sequence = next_event_sequence + ?,
          updated_at = excluded.updated_at
        RETURNING next_event_sequence - ? AS start_sequence
      `
      )
      .bind(sessionId, newEvents.length + 1, now, newEvents.length, newEvents.length)
      .first<{ start_sequence: number }>();

    const start = cursorRow?.start_sequence ?? 1;

    // Build batch statements
    const statements: D1PreparedStatement[] = [];

    for (let i = 0; i < newEvents.length; i++) {
      const sequence = start + i;
      const event = newEvents[i]!;

      // Build payload with sequence included
      const payload = {
        ...event,
        sequence,
      };

      statements.push(
        this.db
          .prepare(
            `
            INSERT INTO session_events (
              session_id, sequence, timestamp, type, payload_json
            )
            VALUES (?, ?, ?, ?, ?)
          `
          )
          .bind(
            sessionId,
            sequence,
            event.timestamp ?? now,
            event.type,
            JSON.stringify(payload)
          )
      );
    }

    // Update session's event cursor
    statements.push(
      this.db
        .prepare(
          `
          UPDATE sessions
          SET next_event_cursor = ?, updated_at = ?
          WHERE id = ?
        `
        )
        .bind(start + newEvents.length - 1, now, sessionId)
    );

    await this.db.batch(statements);

    return { nextCursor: String(start + newEvents.length - 1) };
  }

  async listSince(
    sessionId: string,
    sinceCursor = "0",
    limit = 100
  ): Promise<{ events: SessionEvent[]; nextCursor: string }> {
    const since = Number.parseInt(sinceCursor, 10) || 0;
    const cappedLimit = Math.min(limit, 100);

    const result = await this.db
      .prepare(
        `
        SELECT session_id, sequence, timestamp, type, payload_json
        FROM session_events
        WHERE session_id = ?
          AND sequence > ?
        ORDER BY sequence ASC
        LIMIT ?
      `
      )
      .bind(sessionId, since, cappedLimit)
      .all<SessionEventRow>();

    const events = result.results.map(mapSessionEventRow);
    const nextCursor =
      events.length > 0
        ? String(events[events.length - 1]!.sequence)
        : String(since);

    return { events, nextCursor };
  }

  async count(sessionId: string): Promise<number> {
    const row = await this.db
      .prepare(
        `
        SELECT COUNT(*) AS count
        FROM session_events
        WHERE session_id = ?
      `
      )
      .bind(sessionId)
      .first<{ count: number }>();

    return row?.count ?? 0;
  }

  async listRecent(
    sessionId: string,
    limit = 20
  ): Promise<SessionEvent[]> {
    const cappedLimit = Math.min(limit, 100);

    const result = await this.db
      .prepare(
        `
        SELECT session_id, sequence, timestamp, type, payload_json
        FROM session_events
        WHERE session_id = ?
        ORDER BY sequence DESC
        LIMIT ?
      `
      )
      .bind(sessionId, cappedLimit)
      .all<SessionEventRow>();

    // Return in ascending order
    return result.results
      .map(mapSessionEventRow)
      .sort((a, b) => a.sequence - b.sequence);
  }

  async trim(sessionId: string, maxEvents: number): Promise<void> {
    // Get current event count
    const countRow = await this.db
      .prepare(
        `
        SELECT COUNT(*) as count FROM session_events WHERE session_id = ?
      `
      )
      .bind(sessionId)
      .first<{ count: number }>();

    const currentCount = countRow?.count ?? 0;

    if (currentCount <= maxEvents) {
      return;
    }

    // Calculate how many to delete
    const toDelete = currentCount - maxEvents;

    // Delete oldest events
    await this.db
      .prepare(
        `
        DELETE FROM session_events
        WHERE session_id = ?
          AND sequence IN (
            SELECT sequence FROM session_events
            WHERE session_id = ?
            ORDER BY sequence ASC
            LIMIT ?
          )
      `
      )
      .bind(sessionId, sessionId, toDelete)
      .run();
  }
}
