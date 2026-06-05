/**
 * Session Data Types
 * 
 * Domain types for session management.
 */

import type { SessionEvent, SessionStatus } from "../types.js";

// Re-export from types for convenience
export type { SessionEvent, SessionStatus } from "../types.js";


export interface SessionMetadataState {
  id: string;
  workspaceId: string;
  workflowId: string;
  name?: string;
  status: SessionStatus;
  nextEventCursor: string;
  updatedAt: number;
  errorMessage?: string;
  maxQueueSize?: number;
  idleTimeout?: string;
  modelId?: string;
}

export interface SessionSummary {
  id: string;
  workspaceId: string;
  workflowId: string;
  name?: string;
  status: SessionStatus;
  messageCount: number;
  updatedAt: number;
  isActive: boolean;
  modelId?: string;
  containers?: string[];
}

export interface SessionListFilter {
  workspaceId: string;
  status?: SessionStatus | "all";
  limit?: number;
  offset?: number;
  updatedAfter?: number;
  updatedBefore?: number;
}

export interface NewSessionEvent {
  type: string;
  timestamp: number;
  [key: string]: unknown;
}

export interface CompleteSessionEvent extends NewSessionEvent {
  sequence: number;
}

export type SessionInputEvent =
  | { type: "prompt"; content: string; maxTurns?: number; apiReceivedAt?: number; apiRequestId?: string }
  | { type: "steer"; content: string }
  | { type: "fork"; parentId: string }
  | { type: "close" };

export interface QueueStatus {
  pending: number;
  max: number;
  events: SessionInputEvent[];
}

export interface EnqueueResult {
  ok: boolean;
  queued: number;
  error?: string;
}

export interface DequeueResult {
  event: SessionInputEvent | null;
  remaining: number;
}

// Drizzle-backed session repository implementation.

import { and, asc, count, desc, eq, gt, inArray, lt, max, sql } from "drizzle-orm";
import { createDb, type Db } from "./db.js";
import {
  sessionCounters,
  sessionEvents,
  sessionInputQueue,
  sessionMessages,
  sessionRuntime,
  sessions,
} from "./schema.js";

function mapSession(row: typeof sessions.$inferSelect): SessionMetadataState {
  return {
    id: row.id,
    workspaceId: row.workspaceId ?? "",
    workflowId: row.workflowId,
    name: row.name ?? undefined,
    status: row.status as SessionStatus,
    nextEventCursor: String(row.nextEventCursor),
    updatedAt: row.updatedAt,
    errorMessage: row.errorMessage ?? undefined,
    maxQueueSize: row.maxQueueSize,
    idleTimeout: row.idleTimeout ?? undefined,
    modelId: row.modelId ?? undefined,
  };
}

function mapSessionSummary(row: {
  id: string;
  workspaceId: string | null;
  workflowId: string;
  name: string | null;
  status: string;
  updatedAt: number;
  eventCount: number;
  active: number;
  modelId: string | null;
}): SessionSummary {
  return {
    id: row.id,
    workspaceId: row.workspaceId ?? "",
    workflowId: row.workflowId,
    name: row.name ?? undefined,
    status: row.status as SessionStatus,
    messageCount: row.eventCount,
    updatedAt: row.updatedAt,
    isActive: Boolean(row.active),
    modelId: row.modelId ?? undefined,
  };
}

export class SessionRepository {
  private readonly db: Db;

  constructor(db: Db | D1Database) {
    this.db = "query" in db ? db : createDb(db);
  }

  async save(session: SessionMetadataState): Promise<void> {
    const now = session.updatedAt || Date.now();

    await this.db
      .insert(sessions)
      .values({
        id: session.id,
        workspaceId: session.workspaceId,
        workflowId: session.workflowId,
        name: session.name ?? null,
        status: session.status,
        nextEventCursor: Number(session.nextEventCursor || 0),
        updatedAt: now,
        errorMessage: session.errorMessage ?? null,
        maxQueueSize: session.maxQueueSize ?? 100,
        idleTimeout: session.idleTimeout ?? null,
        modelId: session.modelId ?? null,
      })
      .onConflictDoUpdate({
        target: sessions.id,
        set: {
          workspaceId: session.workspaceId,
          workflowId: session.workflowId,
          name: sql`coalesce(excluded.name, ${sessions.name})`,
          status: session.status,
          nextEventCursor: Number(session.nextEventCursor || 0),
          updatedAt: now,
          errorMessage: session.errorMessage ?? null,
          maxQueueSize: session.maxQueueSize ?? 100,
          idleTimeout: session.idleTimeout ?? null,
          modelId: sql`coalesce(excluded.model_id, ${sessions.modelId})`,
        },
      });

    await this.db
      .insert(sessionCounters)
      .values({
        sessionId: session.id,
        workspaceId: session.workspaceId,
        nextQueueSequence: 1,
        nextEventSequence: 1,
        nextMessageSequence: 1,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: sessionCounters.sessionId,
        set: {
          workspaceId: session.workspaceId,
          updatedAt: now,
        },
      });
  }

  async findById(sessionId: string): Promise<SessionMetadataState | null> {
    const row = await this.db.query.sessions.findFirst({
      where: eq(sessions.id, sessionId),
    });

    return row ? mapSession(row) : null;
  }

  async findByIdInWorkspace(
    workspaceId: string,
    sessionId: string
  ): Promise<SessionMetadataState | null> {
    const row = await this.db.query.sessions.findFirst({
      where: and(eq(sessions.id, sessionId), eq(sessions.workspaceId, workspaceId)),
    });

    return row ? mapSession(row) : null;
  }

  async markError(sessionId: string, message: string): Promise<void> {
    await this.db
      .update(sessions)
      .set({ status: "error", errorMessage: message, updatedAt: Date.now() })
      .where(eq(sessions.id, sessionId));
  }

  async markProcessing(sessionId: string, workflowId: string): Promise<void> {
    await this.db
      .update(sessions)
      .set({
        status: "processing",
        workflowId,
        errorMessage: null,
        updatedAt: Date.now(),
      })
      .where(eq(sessions.id, sessionId));
  }

  async markClosed(
    sessionId: string,
    reason: "user" | "timeout" | "error"
  ): Promise<void> {
    const status: SessionStatus = reason === "timeout" ? "expired" : "closed";
    const now = Date.now();

    await this.db
      .update(sessions)
      .set({ status, updatedAt: now })
      .where(eq(sessions.id, sessionId));

    await this.db
      .update(sessionRuntime)
      .set({ active: 0, updatedAt: now })
      .where(eq(sessionRuntime.sessionId, sessionId));
  }

  async rename(sessionId: string, workspaceId: string, name: string): Promise<boolean> {
    const result = await this.db
      .update(sessions)
      .set({ name, updatedAt: Date.now() })
      .where(and(eq(sessions.id, sessionId), eq(sessions.workspaceId, workspaceId)))
      .returning({ id: sessions.id });

    return result.length > 0;
  }

  async delete(sessionId: string, workspaceId: string): Promise<boolean> {
    const result = await this.db
      .delete(sessions)
      .where(and(eq(sessions.id, sessionId), eq(sessions.workspaceId, workspaceId)))
      .returning({ id: sessions.id });

    return result.length > 0;
  }

  async list(filter: SessionListFilter): Promise<SessionSummary[]> {
    const limit = Math.min(filter.limit ?? 50, 100);
    const offset = filter.offset ?? 0;
    const where =
      filter.status && filter.status !== "all"
        ? and(eq(sessions.workspaceId, filter.workspaceId), eq(sessions.status, filter.status))
        : eq(sessions.workspaceId, filter.workspaceId);

    const rows = await this.db
      .select({
        id: sessions.id,
        workspaceId: sessions.workspaceId,
        workflowId: sessions.workflowId,
        name: sessions.name,
        status: sessions.status,
        updatedAt: sessions.updatedAt,
        eventCount: count(sessionMessages.sequence),
        active: sql<number>`coalesce(max(${sessionRuntime.active}), 0)`,
        modelId: sessions.modelId,
      })
      .from(sessions)
      .leftJoin(sessionMessages, eq(sessionMessages.sessionId, sessions.id))
      .leftJoin(sessionRuntime, eq(sessionRuntime.sessionId, sessions.id))
      .where(where)
      .groupBy(sessions.id)
      .orderBy(desc(sessions.updatedAt))
      .limit(limit)
      .offset(offset);

    return rows.map(mapSessionSummary);
  }

  async count(filter: SessionListFilter): Promise<number> {
    const where =
      filter.status && filter.status !== "all"
        ? and(eq(sessions.workspaceId, filter.workspaceId), eq(sessions.status, filter.status))
        : eq(sessions.workspaceId, filter.workspaceId);

    const result = await this.db
      .select({ value: count() })
      .from(sessions)
      .where(where);

    return result[0]?.value ?? 0;
  }
}

// Session Event Repository Implementation

function getD1Client(db: Db): D1Database {
  return db.$client;
}

function resolveDb(db: Db | D1Database): Db {
  return "query" in db ? db : createDb(db);
}

function mapSessionEvent(row: typeof sessionEvents.$inferSelect): SessionEvent {
  const payload = JSON.parse(row.payloadJson) as Record<string, unknown>;
  return {
    ...payload,
    sequence: row.sequence,
    type: row.type,
    timestamp: row.timestamp,
  } as SessionEvent;
}

export class SessionEventRepository {
  private readonly db: Db;
  private readonly d1: D1Database;

  constructor(db: Db | D1Database) {
    this.db = resolveDb(db);
    this.d1 = getD1Client(this.db);
  }

  async latestCursor(sessionId: string): Promise<string> {
    const rows = await this.db
      .select({ cursor: max(sessionEvents.sequence) })
      .from(sessionEvents)
      .where(eq(sessionEvents.sessionId, sessionId));

    return String(rows[0]?.cursor ?? 0);
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
    const cursorRow = await this.d1
      .prepare(
        `
        INSERT INTO session_counters (
          session_id, next_queue_sequence, next_event_sequence, next_message_sequence, updated_at
        )
        VALUES (?, 1, ?, 1, ?)
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
        this.d1
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
      this.d1
        .prepare(
          `
          UPDATE sessions
          SET next_event_cursor = ?, updated_at = ?
          WHERE id = ?
        `
        )
        .bind(start + newEvents.length - 1, now, sessionId)
    );

    await this.d1.batch(statements);

    return { nextCursor: String(start + newEvents.length - 1) };
  }

  async listSince(
    sessionId: string,
    sinceCursor = "0",
    limit = 100
  ): Promise<{ events: SessionEvent[]; nextCursor: string }> {
    const since = Number.parseInt(sinceCursor, 10) || 0;
    const cappedLimit = Math.min(limit, 100);

    const rows = await this.db.query.sessionEvents.findMany({
      where: and(
        eq(sessionEvents.sessionId, sessionId),
        gt(sessionEvents.sequence, since)
      ),
      orderBy: [asc(sessionEvents.sequence)],
      limit: cappedLimit,
    });

    const events = rows.map(mapSessionEvent);
    const nextCursor =
      events.length > 0
        ? String(events[events.length - 1]!.sequence)
        : String(since);

    return { events, nextCursor };
  }

  async count(sessionId: string): Promise<number> {
    const rows = await this.db
      .select({ value: count() })
      .from(sessionEvents)
      .where(eq(sessionEvents.sessionId, sessionId));

    return rows[0]?.value ?? 0;
  }

  async listRecent(
    sessionId: string,
    limit = 20
  ): Promise<SessionEvent[]> {
    const cappedLimit = Math.min(limit, 100);

    const rows = await this.db.query.sessionEvents.findMany({
      where: eq(sessionEvents.sessionId, sessionId),
      orderBy: [desc(sessionEvents.sequence)],
      limit: cappedLimit,
    });

    // Return in ascending order
    return rows
      .map(mapSessionEvent)
      .sort((a, b) => a.sequence - b.sequence);
  }

  async listBefore(
    sessionId: string,
    beforeCursor: string,
    limit = 100
  ): Promise<SessionEvent[]> {
    const before = Number.parseInt(beforeCursor, 10) || 0;
    if (before <= 1) return [];

    const cappedLimit = Math.min(limit, 100);

    const rows = await this.db.query.sessionEvents.findMany({
      where: and(
        eq(sessionEvents.sessionId, sessionId),
        lt(sessionEvents.sequence, before)
      ),
      orderBy: [desc(sessionEvents.sequence)],
      limit: cappedLimit,
    });

    return rows
      .map(mapSessionEvent)
      .sort((a, b) => a.sequence - b.sequence);
  }

  async trim(sessionId: string, maxEvents: number): Promise<void> {
    const currentCount = await this.count(sessionId);

    if (currentCount <= maxEvents) {
      return;
    }

    // Calculate how many to delete
    const toDelete = currentCount - maxEvents;

    const oldest = await this.db.query.sessionEvents.findMany({
      columns: { sequence: true },
      where: eq(sessionEvents.sessionId, sessionId),
      orderBy: [asc(sessionEvents.sequence)],
      limit: toDelete,
    });

    const sequences = oldest.map((event) => event.sequence);
    if (sequences.length === 0) {
      return;
    }

    await this.db
      .delete(sessionEvents)
      .where(
        and(
          eq(sessionEvents.sessionId, sessionId),
          inArray(sessionEvents.sequence, sequences)
        )
      );
  }
}

// Input Queue Repository Implementation

const DEFAULT_MAX_QUEUE_SIZE = 100;


export class InputQueueRepository {
  private readonly db: Db;
  private readonly d1: D1Database;

  constructor(db: Db | D1Database) {
    this.db = resolveDb(db);
    this.d1 = this.db.$client;
  }

  async status(sessionId: string): Promise<QueueStatus> {
    const rows = await this.db.query.sessionInputQueue.findMany({
      columns: { eventJson: true },
      where: eq(sessionInputQueue.sessionId, sessionId),
      orderBy: [asc(sessionInputQueue.sequence)],
      limit: DEFAULT_MAX_QUEUE_SIZE,
    });

    const events = rows.map(
      (row) => JSON.parse(row.eventJson) as SessionInputEvent
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
    const row = await this.d1
      .prepare(
        `
        INSERT INTO session_counters (
          session_id, next_queue_sequence, next_event_sequence, next_message_sequence, updated_at
        )
        VALUES (?, 2, 1, 1, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          next_queue_sequence = next_queue_sequence + 1,
          updated_at = excluded.updated_at
        RETURNING next_queue_sequence - 1 AS sequence
      `
      )
      .bind(sessionId, now)
      .first<{ sequence: number }>();

    await this.db.insert(sessionInputQueue).values({
      sessionId,
      sequence: row?.sequence ?? 1,
      eventJson: JSON.stringify(event),
      createdAt: now,
    });

    return {
      ok: true,
      queued: queue.pending + 1,
    };
  }

  async dequeue(sessionId: string): Promise<DequeueResult> {
    // Atomically remove and return the first queued event. This prevents two
    // direct repository callers from observing the same queue row.
    const row = await this.d1
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

    const remainingRows = await this.db
      .select({ value: count() })
      .from(sessionInputQueue)
      .where(eq(sessionInputQueue.sessionId, sessionId));

    return {
      event: JSON.parse(row.event_json) as SessionInputEvent,
      remaining: remainingRows[0]?.value ?? 0,
    };
  }
}
