import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";
import { SessionRepository, SessionRunRepository, ToolRunRepository } from "../../../src/data/index.js";

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

describe("D1 ToolRunRepository", () => {
  it("records a running tool run and updates it to terminal state", async () => {
    const { db, dispose } = await createDb();
    try {
      await createSession(db);
      const repo = new ToolRunRepository(db);

      const running = await repo.markRunning({
        sessionId: "session-1",
        workspaceId: DEFAULT_WORKSPACE_ID,
        toolCallId: "tool-1",
        toolName: "container_bash",
        input: { command: "pnpm test" },
        internalState: { commandId: "cmd-1" },
        partialResult: { content: [{ type: "text", text: "still running" }], details: { pending: true } },
      });

      expect(running.status).toBe("running");
      expect(running.internalState).toEqual({ commandId: "cmd-1" });
      expect(running.partialResult).toMatchObject({ details: { pending: true } });

      const terminal = await repo.markTerminal({
        sessionId: "session-1",
        workspaceId: DEFAULT_WORKSPACE_ID,
        toolCallId: "tool-1",
        toolName: "container_bash",
        input: { command: "pnpm test" },
        status: "complete",
        result: { content: [{ type: "text", text: "ok" }], details: { ok: true } },
      });

      expect(terminal.status).toBe("complete");
      expect(terminal.result).toMatchObject({ details: { ok: true } });
      expect(terminal.completedAt).toEqual(expect.any(Number));
    } finally {
      await dispose();
    }
  });

  it("upserts by session and tool call instead of creating duplicate logical runs", async () => {
    const { db, dispose } = await createDb();
    try {
      await createSession(db);
      const repo = new ToolRunRepository(db);

      await repo.markRunning({
        sessionId: "session-1",
        workspaceId: DEFAULT_WORKSPACE_ID,
        toolCallId: "tool-1",
        toolName: "execute_code",
        input: { code: "one" },
      });
      await repo.markRunning({
        sessionId: "session-1",
        workspaceId: DEFAULT_WORKSPACE_ID,
        toolCallId: "tool-1",
        toolName: "execute_code",
        input: { code: "two" },
      });

      const row = await repo.findByToolCall("session-1", "tool-1");
      const count = await db.prepare("SELECT count(*) AS value FROM tool_runs").first<{ value: number }>();

      expect(count?.value).toBe(1);
      expect(row?.input).toEqual({ code: "two" });
    } finally {
      await dispose();
    }
  });

  it("wakes a delayed session run when a tool run becomes terminal", async () => {
    const { db, dispose } = await createDb();
    try {
      await createSession(db);
      const runs = new SessionRunRepository(db);
      await runs.create({
        id: "run-1",
        sessionId: "session-1",
        workspaceId: DEFAULT_WORKSPACE_ID,
        input: { type: "prompt", content: "hello" },
      });
      expect(await runs.claim({ runId: "run-1", workerId: "worker-1", leaseMs: 30_000 })).toBeTruthy();
      await runs.releaseRunnable("run-1", "worker-1", 25_000);
      expect(await runs.listDue()).toEqual([]);

      const toolRuns = new ToolRunRepository(db);
      await toolRuns.markRunning({
        sessionId: "session-1",
        workspaceId: DEFAULT_WORKSPACE_ID,
        toolCallId: "tool-1",
        toolName: "container_bash",
        input: { command: "pnpm test" },
      });
      await toolRuns.markTerminal({
        sessionId: "session-1",
        workspaceId: DEFAULT_WORKSPACE_ID,
        toolCallId: "tool-1",
        toolName: "container_bash",
        input: { command: "pnpm test" },
        status: "complete",
        result: { content: [{ type: "text", text: "ok" }], details: { ok: true } },
      });

      expect(await runs.listDue()).toEqual([{ id: "run-1", sessionId: "session-1" }]);
    } finally {
      await dispose();
    }
  });
});
