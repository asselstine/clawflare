// D1 Input Queue Repository Tests

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";
import { InputQueueRepository } from "../../../src/data/sessions.js";
import { SessionRepository } from "../../../src/data/sessions.js";
import type { SessionInputEvent } from "../../../src/data/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "../../../migrations");

// Default workspace for testing - Phase 6 adds workspace scoping
const DEFAULT_WORKSPACE_ID = "test-workspace";

/**
 * Parse SQL migration file into executable statements.
 * Handles inline comments and multi-line statements.
 */
function migrationStatements(migrationFile: string): string[] {
  let content = readFileSync(join(MIGRATIONS_DIR, migrationFile), "utf-8");
  
  // Remove PRAGMA statements (D1 handles these separately)
  content = content.replace(/^PRAGMA\s+foreign_keys\s*=\s*ON;$/gim, "");
  
  // Remove all SQL comments (-- style)
  content = content.replace(/--[^\n]*/g, "");
  
  // Split on semicolons to get statements
  const rawStatements = content.split(';');
  
  // Clean up each statement
  return rawStatements
    .map(stmt => stmt.trim())
    .filter(stmt => stmt.length > 0)
    // Normalize whitespace
    .map(stmt => stmt.replace(/\s+/g, ' '));
}

function allMigrationStatements(): string[] {
  const files = [
    "0001_initial_schema.sql",
    "007_encrypted_secrets.sql",
    "008_job_authorization_snapshots.sql",
    "009_add_workflow_auth_job_id.sql",
  ];
  return files.flatMap((file) => migrationStatements(file));
}

async function createDb(): Promise<{ db: D1Database; dispose: () => Promise<void> }> {
  const mf = new Miniflare({
    script: "export default { fetch() { return new Response('ok'); } }",
    modules: true,
    d1Databases: ["DB"],
  });
  const db = await mf.getD1Database("DB");
  for (const statement of allMigrationStatements()) {
    await db.exec(`${statement};`);
  }
  return { db, dispose: () => mf.dispose() };
}

async function createSession(db: D1Database, sessionId = "session-1"): Promise<void> {
  await new SessionRepository(db).save({
    id: sessionId,
    workspaceId: DEFAULT_WORKSPACE_ID, // Phase 6: workspace scoping
    workflowId: "workflow-1",
    status: "idle",
    nextEventCursor: "0",
    updatedAt: Date.now(),
    maxQueueSize: 100,
  });
}

describe("D1 Input Queue Repository", () => {
  it("enqueues and dequeues in order", async () => {
    const { db, dispose } = await createDb();
    try {
      await createSession(db);
      const repo = new InputQueueRepository(db);

      await repo.enqueue("session-1", { type: "prompt", content: "one" });
      await repo.enqueue("session-1", { type: "prompt", content: "two" });

      expect((await repo.status("session-1")).pending).toBe(2);
      expect(await repo.dequeue("session-1")).toEqual({
        event: { type: "prompt", content: "one" },
        remaining: 1,
      });
      expect(await repo.dequeue("session-1")).toEqual({
        event: { type: "prompt", content: "two" },
        remaining: 0,
      });
      expect(await repo.dequeue("session-1")).toEqual({
        event: null,
        remaining: 0,
      });
    } finally {
      await dispose();
    }
  });

  it("concurrent enqueue reserves unique sequences", async () => {
    const { db, dispose } = await createDb();
    try {
      await createSession(db);
      const repo = new InputQueueRepository(db);

      const events: SessionInputEvent[] = Array.from({ length: 50 }, (_, i) => ({
        type: "prompt",
        content: `prompt-${i}`,
      }));

      const results = await Promise.all(events.map((event) => repo.enqueue("session-1", event)));
      expect(results.every((result) => result.ok)).toBe(true);

      const rows = await db
        .prepare(
          `SELECT sequence FROM session_input_queue WHERE session_id = ? ORDER BY sequence ASC`
        )
        .bind("session-1")
        .all<{ sequence: number }>();

      expect(rows.results.length).toBe(50);
      expect(rows.results.map((row) => row.sequence)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    } finally {
      await dispose();
    }
  });

  it("concurrent dequeue never returns duplicate events", async () => {
    const { db, dispose } = await createDb();
    try {
      await createSession(db);
      const repo = new InputQueueRepository(db);

      for (let i = 0; i < 50; i++) {
        await repo.enqueue("session-1", { type: "prompt", content: `prompt-${i}` });
      }

      const results = await Promise.all(Array.from({ length: 50 }, () => repo.dequeue("session-1")));
      const contents = results
        .map((result) => result.event)
        .filter((event): event is { type: "prompt"; content: string } => event?.type === "prompt")
        .map((event) => event.content);

      expect(contents.length).toBe(50);
      expect(new Set(contents).size).toBe(50);
      expect((await repo.status("session-1")).pending).toBe(0);
    } finally {
      await dispose();
    }
  });
});