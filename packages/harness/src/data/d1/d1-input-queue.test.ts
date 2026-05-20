// D1 Input Queue Repository Tests

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";
import { D1InputQueueRepository } from "./d1-input-queue.js";
import { D1SessionRepository } from "./d1-sessions.js";
import type { SessionInputEvent } from "../interfaces.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATION_PATH = join(__dirname, "../../../migrations/0001_initial_data_layer.sql");

function migrationStatements(): string[] {
  return readFileSync(MIGRATION_PATH, "utf-8")
    .replace(/^--.*$/gm, "")
    .replace(/^PRAGMA\s+foreign_keys\s*=\s*ON;$/gim, "")
    .split(";")
    .map((statement) => statement.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

async function createDb(): Promise<{ db: D1Database; dispose: () => Promise<void> }> {
  const mf = new Miniflare({
    script: "export default { fetch() { return new Response('ok'); } }",
    modules: true,
    d1Databases: ["DB"],
  });
  const db = await mf.getD1Database("DB");
  for (const statement of migrationStatements()) {
    await db.exec(`${statement};`);
  }
  return { db, dispose: () => mf.dispose() };
}

async function createSession(db: D1Database, sessionId = "session-1"): Promise<void> {
  await new D1SessionRepository(db).save({
    id: sessionId,
    workflowId: "workflow-1",
    status: "idle",
    nextEventCursor: "0",
    updatedAt: Date.now(),
    maxQueueSize: 100,
  });
}

test("D1InputQueueRepository enqueues and dequeues in order", async () => {
  const { db, dispose } = await createDb();
  try {
    await createSession(db);
    const repo = new D1InputQueueRepository(db);

    await repo.enqueue("session-1", { type: "prompt", content: "one" });
    await repo.enqueue("session-1", { type: "prompt", content: "two" });

    assert.equal((await repo.status("session-1")).pending, 2);
    assert.deepEqual(await repo.dequeue("session-1"), {
      event: { type: "prompt", content: "one" },
      remaining: 1,
    });
    assert.deepEqual(await repo.dequeue("session-1"), {
      event: { type: "prompt", content: "two" },
      remaining: 0,
    });
    assert.deepEqual(await repo.dequeue("session-1"), {
      event: null,
      remaining: 0,
    });
  } finally {
    await dispose();
  }
});

test("D1InputQueueRepository concurrent enqueue reserves unique sequences", async () => {
  const { db, dispose } = await createDb();
  try {
    await createSession(db);
    const repo = new D1InputQueueRepository(db);

    const events: SessionInputEvent[] = Array.from({ length: 50 }, (_, i) => ({
      type: "prompt",
      content: `prompt-${i}`,
    }));

    const results = await Promise.all(events.map((event) => repo.enqueue("session-1", event)));
    assert.equal(results.every((result) => result.ok), true);

    const rows = await db
      .prepare(
        `SELECT sequence FROM session_input_queue WHERE session_id = ? ORDER BY sequence ASC`
      )
      .bind("session-1")
      .all<{ sequence: number }>();

    assert.equal(rows.results.length, 50);
    assert.deepEqual(rows.results.map((row) => row.sequence), Array.from({ length: 50 }, (_, i) => i + 1));
  } finally {
    await dispose();
  }
});

test("D1InputQueueRepository concurrent dequeue never returns duplicate events", async () => {
  const { db, dispose } = await createDb();
  try {
    await createSession(db);
    const repo = new D1InputQueueRepository(db);

    for (let i = 0; i < 50; i++) {
      await repo.enqueue("session-1", { type: "prompt", content: `prompt-${i}` });
    }

    const results = await Promise.all(Array.from({ length: 50 }, () => repo.dequeue("session-1")));
    const contents = results
      .map((result) => result.event)
      .filter((event): event is { type: "prompt"; content: string } => event?.type === "prompt")
      .map((event) => event.content);

    assert.equal(contents.length, 50);
    assert.equal(new Set(contents).size, 50);
    assert.equal((await repo.status("session-1")).pending, 0);
  } finally {
    await dispose();
  }
});

export {};
