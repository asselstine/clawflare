import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";
import { SessionRepository } from "../../../src/data/sessions.js";
import { SessionRunRepository } from "../../../src/data/session-runs.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "../../../migrations");
const DEFAULT_WORKSPACE_ID = "test-workspace";

function migrationStatements(migrationFile: string): string[] {
  let content = readFileSync(join(MIGRATIONS_DIR, migrationFile), "utf-8");
  content = content.replace(/^PRAGMA\s+foreign_keys\s*=\s*ON;$/gim, "");
  content = content.replace(/--[^\n]*/g, "");
  return content
    .split(";")
    .map((stmt) => stmt.trim())
    .filter((stmt) => stmt.length > 0)
    .map((stmt) => stmt.replace(/\s+/g, " "));
}

async function createDb(): Promise<{ db: D1Database; dispose: () => Promise<void> }> {
  const mf = new Miniflare({
    script: "export default { fetch() { return new Response('ok'); } }",
    modules: true,
    d1Databases: ["DB"],
  });
  const db = await mf.getD1Database("DB");
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith(".sql"))
    .sort();
  for (const file of files) {
    for (const statement of migrationStatements(file)) {
      await db.exec(`${statement};`);
    }
  }
  return { db, dispose: () => mf.dispose() };
}

async function createSession(db: D1Database, sessionId = "session-1"): Promise<void> {
  await new SessionRepository(db).save({
    id: sessionId,
    workspaceId: DEFAULT_WORKSPACE_ID,
    workflowId: "",
    status: "idle",
    nextEventCursor: "0",
    updatedAt: Date.now(),
    maxQueueSize: 100,
  });
}

describe("D1 SessionRunRepository", () => {
  it("allows only one active claimant for a runnable run", async () => {
    const { db, dispose } = await createDb();
    try {
      await createSession(db);
      const repo = new SessionRunRepository(db);
      await repo.create({
        id: "run-1",
        sessionId: "session-1",
        workspaceId: DEFAULT_WORKSPACE_ID,
        input: { type: "prompt", content: "hello" },
      });

      const claims = await Promise.all([
        repo.claim({ runId: "run-1", workerId: "worker-1", leaseMs: 30_000 }),
        repo.claim({ runId: "run-1", workerId: "worker-2", leaseMs: 30_000 }),
      ]);

      expect(claims.filter(Boolean)).toHaveLength(1);
      expect(claims.find(Boolean)?.status).toBe("running");
    } finally {
      await dispose();
    }
  });

  it("reclaims an expired running lease", async () => {
    const { db, dispose } = await createDb();
    try {
      await createSession(db);
      const repo = new SessionRunRepository(db);
      await repo.create({
        id: "run-1",
        sessionId: "session-1",
        workspaceId: DEFAULT_WORKSPACE_ID,
        input: { type: "prompt", content: "hello" },
      });
      expect(await repo.claim({ runId: "run-1", workerId: "worker-1", leaseMs: 1 })).toBeTruthy();

      await db
        .prepare("UPDATE session_runs SET lease_expires_at = ? WHERE id = ?")
        .bind(Date.now() - 1, "run-1")
        .run();

      const reclaimed = await repo.claim({ runId: "run-1", workerId: "worker-2", leaseMs: 30_000 });
      expect(reclaimed?.leaseOwner).toBe("worker-2");
      expect(reclaimed?.attempt).toBe(2);
    } finally {
      await dispose();
    }
  });

  it("does not claim a run after cancellation has been requested", async () => {
    const { db, dispose } = await createDb();
    try {
      await createSession(db);
      const repo = new SessionRunRepository(db);
      await repo.create({
        id: "run-1",
        sessionId: "session-1",
        workspaceId: DEFAULT_WORKSPACE_ID,
        input: { type: "prompt", content: "hello" },
      });

      await repo.requestCancel("run-1");

      const claimed = await repo.claim({ runId: "run-1", workerId: "worker-1", leaseMs: 30_000 });
      const cancelledRun = await repo.find("run-1");

      expect(claimed).toBeNull();
      expect(cancelledRun?.status).toBe("cancel_requested");
      expect(cancelledRun?.leaseOwner).toBeUndefined();
    } finally {
      await dispose();
    }
  });

  it("replays completed step results without overwriting them", async () => {
    const { db, dispose } = await createDb();
    try {
      await createSession(db);
      const repo = new SessionRunRepository(db);
      await repo.create({
        id: "run-1",
        sessionId: "session-1",
        workspaceId: DEFAULT_WORKSPACE_ID,
        input: { type: "prompt", content: "hello" },
      });

      await repo.completeStep("run-1", "step-1", 1, { value: "first" });
      await repo.completeStep("run-1", "step-1", 2, { value: "second" });

      expect(await repo.getCompletedStep("run-1", "step-1")).toEqual({ value: "first" });
    } finally {
      await dispose();
    }
  });
});
