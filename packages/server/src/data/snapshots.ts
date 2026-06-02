/**
 * Snapshot Data Types
 * 
 * Domain types for agent snapshot management.
 */

// Session Runtime Repository Implementation
import { createDb, type Db } from "./db.js";
import { sessions, sessionRuntime } from "./schema.js";
import { eq } from "drizzle-orm";

export interface SerializedSaveResult {
  serializedJson: string;
  serializedBytes: number;
  written: boolean;
  skippedUnchanged: boolean;
}

function serializedSize(json: string): number {
  return new TextEncoder().encode(json).byteLength;
}

function unchangedSave(serializedJson: string): SerializedSaveResult {
  return {
    serializedJson,
    serializedBytes: serializedSize(serializedJson),
    written: false,
    skippedUnchanged: true,
  };
}

function writtenSave(serializedJson: string): SerializedSaveResult {
  return {
    serializedJson,
    serializedBytes: serializedSize(serializedJson),
    written: true,
    skippedUnchanged: false,
  };
}

export class SessionRuntimeRepository {
  private readonly db: Db;

  constructor(db: Db | D1Database) {
    this.db = "query" in db ? db : createDb(db);
  }

  async getWorkflowId(sessionId: string): Promise<string | null> {
    // Workflow ID is stored in sessions table
    const row = await this.db.query.sessions.findFirst({
      columns: { workflowId: true },
      where: eq(sessions.id, sessionId),
    });

    return row?.workflowId ?? null;
  }

  async saveWorkflowId(sessionId: string, workflowId: string): Promise<void> {
    const now = Date.now();

    await this.db
      .update(sessions)
      .set({ workflowId, updatedAt: now })
      .where(eq(sessions.id, sessionId));
  }

  async isActive(sessionId: string): Promise<boolean> {
    const row = await this.db.query.sessionRuntime.findFirst({
      columns: { active: true },
      where: eq(sessionRuntime.sessionId, sessionId),
    });

    return row ? Boolean(row.active) : false;
  }

  async setActive(sessionId: string, active: boolean): Promise<void> {
    const now = Date.now();

    await this.db
      .insert(sessionRuntime)
      .values({ sessionId, active: active ? 1 : 0, updatedAt: now })
      .onConflictDoUpdate({
        target: sessionRuntime.sessionId,
        set: { active: active ? 1 : 0, updatedAt: now },
      });
  }

  async getWorkflowSession(sessionId: string): Promise<unknown | null> {
    const row = await this.db.query.sessionRuntime.findFirst({
      columns: { workflowSessionJson: true },
      where: eq(sessionRuntime.sessionId, sessionId),
    });

    return row?.workflowSessionJson
      ? (JSON.parse(row.workflowSessionJson) as unknown)
      : null;
  }

  async saveWorkflowSession(
    sessionId: string,
    session: unknown
  ): Promise<SerializedSaveResult> {
    const now = Date.now();

    const workflowSessionJson = JSON.stringify(session);
    const existing = await this.db.query.sessionRuntime.findFirst({
      columns: { workflowSessionJson: true },
      where: eq(sessionRuntime.sessionId, sessionId),
    });
    if (existing?.workflowSessionJson === workflowSessionJson) {
      return unchangedSave(workflowSessionJson);
    }

    await this.db
      .insert(sessionRuntime)
      .values({ sessionId, workflowSessionJson, updatedAt: now })
      .onConflictDoUpdate({
        target: sessionRuntime.sessionId,
        set: { workflowSessionJson, updatedAt: now },
      });
    return writtenSave(workflowSessionJson);
  }

  async getSnapshot(sessionId: string): Promise<unknown | null> {
    const row = await this.db.query.sessionRuntime.findFirst({
      columns: { snapshotJson: true },
      where: eq(sessionRuntime.sessionId, sessionId),
    });

    return row?.snapshotJson
      ? (JSON.parse(row.snapshotJson) as unknown)
      : null;
  }

  async saveSnapshot(sessionId: string, snapshot: unknown): Promise<SerializedSaveResult> {
    const now = Date.now();

    const snapshotJson = JSON.stringify(snapshot);
    const existing = await this.db.query.sessionRuntime.findFirst({
      columns: { snapshotJson: true },
      where: eq(sessionRuntime.sessionId, sessionId),
    });
    if (existing?.snapshotJson === snapshotJson) {
      return unchangedSave(snapshotJson);
    }

    await this.db
      .insert(sessionRuntime)
      .values({ sessionId, snapshotJson, updatedAt: now })
      .onConflictDoUpdate({
        target: sessionRuntime.sessionId,
        set: { snapshotJson, updatedAt: now },
      });
    return writtenSave(snapshotJson);
  }
}

// Snapshot Repository Implementation

export class SnapshotRepository {
  private readonly db: Db;

  constructor(db: Db | D1Database) {
    this.db = "query" in db ? db : createDb(db);
  }

  async save(sessionId: string, snapshot: unknown): Promise<SerializedSaveResult> {
    const now = Date.now();

    const snapshotJson = JSON.stringify(snapshot);
    const existing = await this.db.query.sessionRuntime.findFirst({
      columns: { snapshotJson: true },
      where: eq(sessionRuntime.sessionId, sessionId),
    });
    if (existing?.snapshotJson === snapshotJson) {
      return unchangedSave(snapshotJson);
    }

    await this.db
      .insert(sessionRuntime)
      .values({ sessionId, snapshotJson, updatedAt: now })
      .onConflictDoUpdate({
        target: sessionRuntime.sessionId,
        set: { snapshotJson, updatedAt: now },
      });
    return writtenSave(snapshotJson);
  }

  async get(sessionId: string): Promise<unknown | null> {
    const row = await this.db.query.sessionRuntime.findFirst({
      columns: { snapshotJson: true },
      where: eq(sessionRuntime.sessionId, sessionId),
    });

    return row?.snapshotJson
      ? (JSON.parse(row.snapshotJson) as unknown)
      : null;
  }

  async delete(sessionId: string): Promise<void> {
    await this.db
      .update(sessionRuntime)
      .set({ snapshotJson: null, updatedAt: Date.now() })
      .where(eq(sessionRuntime.sessionId, sessionId));
  }
}
