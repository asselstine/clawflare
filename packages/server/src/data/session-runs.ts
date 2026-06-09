import { and, asc, eq, inArray, isNull, lt, or } from "drizzle-orm";
import { createDb, type Db } from "./db.js";
import { sessionRuns, sessionRunSteps } from "./schema.js";
import type { SessionInputEvent } from "./sessions.js";

export type SessionRunStatus =
  | "runnable"
  | "running"
  | "completed"
  | "error"
  | "cancel_requested"
  | "cancelled";

export interface SessionRun {
  id: string;
  sessionId: string;
  workspaceId: string;
  status: SessionRunStatus;
  input: SessionInputEvent;
  attempt: number;
  leaseOwner?: string;
  leaseExpiresAt?: number;
  stepCursor: number;
  errorMessage?: string;
  createdAt: number;
  updatedAt: number;
}

export interface CreateSessionRunParams {
  id: string;
  sessionId: string;
  workspaceId: string;
  input: SessionInputEvent;
}

export interface ClaimSessionRunParams {
  runId: string;
  workerId: string;
  leaseMs: number;
}

export interface DueSessionRun {
  id: string;
  sessionId: string;
}

function resolveDb(db: Db | D1Database): Db {
  return "query" in db ? db : createDb(db);
}

function getD1Client(db: Db): D1Database {
  return db.$client;
}

function mapRun(row: typeof sessionRuns.$inferSelect): SessionRun {
  return {
    id: row.id,
    sessionId: row.sessionId,
    workspaceId: row.workspaceId ?? "",
    status: row.status as SessionRunStatus,
    input: JSON.parse(row.inputJson) as SessionInputEvent,
    attempt: row.attempt,
    leaseOwner: row.leaseOwner ?? undefined,
    leaseExpiresAt: row.leaseExpiresAt ?? undefined,
    stepCursor: row.stepCursor,
    errorMessage: row.errorMessage ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function changed(result: D1Result): boolean {
  return (result.meta as { changes?: number } | undefined)?.changes === 1;
}

export class SessionRunRepository {
  private readonly db: Db;
  private readonly d1: D1Database;

  constructor(db: Db | D1Database) {
    this.db = resolveDb(db);
    this.d1 = getD1Client(this.db);
  }

  async create(params: CreateSessionRunParams): Promise<SessionRun> {
    const now = Date.now();
    await this.db.insert(sessionRuns).values({
      id: params.id,
      sessionId: params.sessionId,
      workspaceId: params.workspaceId,
      status: "runnable",
      inputJson: JSON.stringify(params.input),
      attempt: 0,
      stepCursor: 0,
      createdAt: now,
      updatedAt: now,
    });

    return {
      id: params.id,
      sessionId: params.sessionId,
      workspaceId: params.workspaceId,
      status: "runnable",
      input: params.input,
      attempt: 0,
      stepCursor: 0,
      createdAt: now,
      updatedAt: now,
    };
  }

  async find(runId: string): Promise<SessionRun | null> {
    const row = await this.db.query.sessionRuns.findFirst({
      where: eq(sessionRuns.id, runId),
    });
    return row ? mapRun(row) : null;
  }

  async findActiveForSession(sessionId: string): Promise<SessionRun | null> {
    const row = await this.db.query.sessionRuns.findFirst({
      where: and(
        eq(sessionRuns.sessionId, sessionId),
        inArray(sessionRuns.status, ["runnable", "running", "cancel_requested"])
      ),
      orderBy: [asc(sessionRuns.createdAt)],
    });
    return row ? mapRun(row) : null;
  }

  async claim(params: ClaimSessionRunParams): Promise<SessionRun | null> {
    const now = Date.now();
    const leaseExpiresAt = now + params.leaseMs;
    const result = await this.d1
      .prepare(
        `
        UPDATE session_runs
        SET status = 'running',
            lease_owner = ?,
            lease_expires_at = ?,
            attempt = attempt + 1,
            updated_at = ?
        WHERE id = ?
          AND (
            status = 'runnable'
            OR (status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
          )
      `
      )
      .bind(params.workerId, leaseExpiresAt, now, params.runId, now)
      .run();

    if (!changed(result)) return null;
    return this.find(params.runId);
  }

  async releaseRunnable(runId: string, workerId: string, delayMs = 0): Promise<void> {
    const now = Date.now();
    await this.db
      .update(sessionRuns)
      .set({
        status: "runnable",
        leaseOwner: null,
        leaseExpiresAt: delayMs > 0 ? now + delayMs : null,
        updatedAt: now,
      })
      .where(and(eq(sessionRuns.id, runId), eq(sessionRuns.leaseOwner, workerId)));
  }

  async wakeRunnableForSession(sessionId: string): Promise<number> {
    const now = Date.now();
    const result = await this.d1
      .prepare(
        `
        UPDATE session_runs
        SET lease_expires_at = NULL,
            updated_at = ?
        WHERE session_id = ?
          AND status = 'runnable'
      `
      )
      .bind(now, sessionId)
      .run();
    return (result.meta as { changes?: number } | undefined)?.changes ?? 0;
  }

  async complete(runId: string, workerId: string): Promise<void> {
    const now = Date.now();
    await this.db
      .update(sessionRuns)
      .set({
        status: "completed",
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: now,
      })
      .where(and(eq(sessionRuns.id, runId), eq(sessionRuns.leaseOwner, workerId)));
  }

  async fail(runId: string, workerId: string, message: string): Promise<void> {
    const now = Date.now();
    await this.db
      .update(sessionRuns)
      .set({
        status: "error",
        errorMessage: message,
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: now,
      })
      .where(and(eq(sessionRuns.id, runId), eq(sessionRuns.leaseOwner, workerId)));
  }

  async requestCancel(runId: string): Promise<void> {
    await this.db
      .update(sessionRuns)
      .set({ status: "cancel_requested", updatedAt: Date.now() })
      .where(and(eq(sessionRuns.id, runId), inArray(sessionRuns.status, ["runnable", "running"])));
  }

  async cancel(runId: string): Promise<void> {
    const now = Date.now();
    await this.db
      .update(sessionRuns)
      .set({
        status: "cancelled",
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: now,
      })
      .where(eq(sessionRuns.id, runId));
  }

  async getCompletedStep(runId: string, stepName: string): Promise<unknown | undefined> {
    const row = await this.db.query.sessionRunSteps.findFirst({
      columns: { resultJson: true },
      where: and(eq(sessionRunSteps.runId, runId), eq(sessionRunSteps.stepName, stepName)),
    });
    return row ? JSON.parse(row.resultJson) : undefined;
  }

  async completeStep(runId: string, stepName: string, attempt: number, result: unknown): Promise<void> {
    const now = Date.now();
    await this.db
      .insert(sessionRunSteps)
      .values({
        runId,
        stepName,
        status: "completed",
        resultJson: JSON.stringify(result),
        attempt,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();
  }

  async listDue(limit = 10): Promise<DueSessionRun[]> {
    const now = Date.now();
    const rows = await this.db.query.sessionRuns.findMany({
      columns: { id: true, sessionId: true },
      where: or(
        and(
          eq(sessionRuns.status, "runnable"),
          or(isNull(sessionRuns.leaseExpiresAt), lt(sessionRuns.leaseExpiresAt, now))
        ),
        and(eq(sessionRuns.status, "running"), lt(sessionRuns.leaseExpiresAt, now))
      ),
      orderBy: [asc(sessionRuns.updatedAt)],
      limit,
    });

    return rows;
  }
}
