// D1 Session Events Repository Tests

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";
import { SessionEventRepository } from "../../../src/data/sessions.js";
import { SessionRepository } from "../../../src/data/sessions.js";

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
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .flatMap((file) => migrationStatements(file));
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

describe("D1 Session Event Repository", () => {
  it("appends, lists, counts, and lists recent events", async () => {
    const { db, dispose } = await createDb();
    try {
      await createSession(db);
      const repo = new SessionEventRepository(db);

      expect(await repo.latestCursor("session-1")).toBe("0");
      expect(await repo.count("session-1")).toBe(0);

      const appendResult = await repo.append("session-1", [
        { type: "message", timestamp: 1, value: "one" },
        { type: "message", timestamp: 2, value: "two" },
        { type: "message", timestamp: 3, value: "three" },
      ]);

      expect(appendResult.nextCursor).toBe("3");
      expect(await repo.latestCursor("session-1")).toBe("3");
      expect(await repo.count("session-1")).toBe(3);

      const listed = await repo.listSince("session-1", "1", 10);
      expect(listed.nextCursor).toBe("3");
      expect(listed.events.map((event) => event.sequence)).toEqual([2, 3]);

      const recent = await repo.listRecent("session-1", 2);
      expect(recent.map((event) => event.sequence)).toEqual([2, 3]);
    } finally {
      await dispose();
    }
  });

  it("concurrent appends reserve unique contiguous sequences", async () => {
    const { db, dispose } = await createDb();
    try {
      await createSession(db);
      const repo = new SessionEventRepository(db);

      await Promise.all(
        Array.from({ length: 25 }, (_, i) =>
          repo.append("session-1", [{ type: "message", timestamp: Date.now(), value: i }])
        )
      );

      const all = await repo.listSince("session-1", "0", 100);
      expect(all.events.length).toBe(25);
      expect(all.events.map((event) => event.sequence)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
      expect(new Set(all.events.map((event) => event.sequence)).size).toBe(25);
    } finally {
      await dispose();
    }
  });
});
