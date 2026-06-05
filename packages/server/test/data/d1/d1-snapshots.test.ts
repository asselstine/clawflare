import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";
import { SessionRepository } from "../../../src/data/sessions.js";
import { SessionRuntimeRepository, SnapshotRepository } from "../../../src/data/snapshots.js";

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
    workspaceId: DEFAULT_WORKSPACE_ID,
    workflowId: "workflow-1",
    status: "idle",
    nextEventCursor: "0",
    updatedAt: Date.now(),
    maxQueueSize: 100,
  });
}

describe("D1 Snapshot Repositories", () => {
  it("skips unchanged workflow session writes and writes changed sessions", async () => {
    const { db, dispose } = await createDb();
    try {
      await createSession(db);
      const repo = new SessionRuntimeRepository(db);
      const session = {
        id: "session-1",
        status: "idle",
        messages: [{ role: "user", content: "hello" }],
      };

      const first = await repo.saveWorkflowSession("session-1", session);
      expect(first.written).toBe(true);
      expect(first.skippedUnchanged).toBe(false);
      expect(first.serializedJson).toBe(JSON.stringify(session));
      expect(first.serializedBytes).toBeGreaterThan(0);

      const before = await db
        .prepare("SELECT workflow_session_json, updated_at FROM session_runtime WHERE session_id = ?")
        .bind("session-1")
        .first<{ workflow_session_json: string; updated_at: number }>();

      const second = await repo.saveWorkflowSession("session-1", session);
      expect(second.written).toBe(false);
      expect(second.skippedUnchanged).toBe(true);
      expect(second.serializedJson).toBe(first.serializedJson);

      const unchanged = await db
        .prepare("SELECT workflow_session_json, updated_at FROM session_runtime WHERE session_id = ?")
        .bind("session-1")
        .first<{ workflow_session_json: string; updated_at: number }>();
      expect(unchanged).toEqual(before);

      const changed = await repo.saveWorkflowSession("session-1", {
        ...session,
        status: "processing",
      });
      expect(changed.written).toBe(true);
      expect(changed.skippedUnchanged).toBe(false);
      expect(await repo.getWorkflowSession("session-1")).toMatchObject({ status: "processing" });
    } finally {
      await dispose();
    }
  });

  it("skips unchanged snapshot writes", async () => {
    const { db, dispose } = await createDb();
    try {
      await createSession(db);
      const repo = new SnapshotRepository(db);
      const snapshot = { cursor: "1", state: { active: true } };

      const first = await repo.save("session-1", snapshot);
      const second = await repo.save("session-1", snapshot);

      expect(first.written).toBe(true);
      expect(second.written).toBe(false);
      expect(second.skippedUnchanged).toBe(true);
      expect(await repo.get("session-1")).toEqual(snapshot);
    } finally {
      await dispose();
    }
  });

  it("round-trips hot runtime context and skips unchanged writes", async () => {
    const { db, dispose } = await createDb();
    try {
      await createSession(db);
      const repo = new SessionRuntimeRepository(db);
      const hotContext = {
        workspaceId: DEFAULT_WORKSPACE_ID,
        resolvedModel: {
          id: "model-1",
          provider: "amazon-bedrock",
          modelName: "moonshotai.kimi-k2.5",
          secrets: { AWS_BEARER_TOKEN_BEDROCK: "secret" },
          config: {},
        },
        toolRefs: ["code.eval"],
        cachedAt: Date.now(),
      };

      const first = await repo.saveHotContext("session-1", hotContext);
      const second = await repo.saveHotContext("session-1", hotContext);

      expect(first.written).toBe(true);
      expect(second.written).toBe(false);
      expect(second.skippedUnchanged).toBe(true);
      expect(await repo.getHotContext("session-1")).toEqual(hotContext);

      await repo.clearHotContext("session-1");
      expect(await repo.getHotContext("session-1")).toBeNull();
    } finally {
      await dispose();
    }
  });
});
