// D1 Session Events Repository Tests

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";
import { D1SessionEventRepository } from "../../../src/data/d1/d1-session-events.js";
import { D1SessionRepository } from "../../../src/data/d1/d1-sessions.js";

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

test("D1SessionEventRepository appends, lists, counts, and lists recent events", async () => {
  const { db, dispose } = await createDb();
  try {
    await createSession(db);
    const repo = new D1SessionEventRepository(db);

    assert.equal(await repo.latestCursor("session-1"), "0");
    assert.equal(await repo.count("session-1"), 0);

    const appendResult = await repo.append("session-1", [
      { type: "message", timestamp: 1, value: "one" },
      { type: "message", timestamp: 2, value: "two" },
      { type: "message", timestamp: 3, value: "three" },
    ]);

    assert.equal(appendResult.nextCursor, "3");
    assert.equal(await repo.latestCursor("session-1"), "3");
    assert.equal(await repo.count("session-1"), 3);

    const listed = await repo.listSince("session-1", "1", 10);
    assert.equal(listed.nextCursor, "3");
    assert.deepEqual(listed.events.map((event) => event.sequence), [2, 3]);

    const recent = await repo.listRecent("session-1", 2);
    assert.deepEqual(recent.map((event) => event.sequence), [2, 3]);
  } finally {
    await dispose();
  }
});

test("D1SessionEventRepository concurrent appends reserve unique contiguous sequences", async () => {
  const { db, dispose } = await createDb();
  try {
    await createSession(db);
    const repo = new D1SessionEventRepository(db);

    await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        repo.append("session-1", [{ type: "message", timestamp: Date.now(), value: i }])
      )
    );

    const all = await repo.listSince("session-1", "0", 100);
    assert.equal(all.events.length, 25);
    assert.deepEqual(all.events.map((event) => event.sequence), Array.from({ length: 25 }, (_, i) => i + 1));
    assert.equal(new Set(all.events.map((event) => event.sequence)).size, 25);
  } finally {
    await dispose();
  }
});

export {};
