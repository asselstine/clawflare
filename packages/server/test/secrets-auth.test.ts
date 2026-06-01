import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";
import { SessionRepository } from "../src/data/sessions.js";
import { validateSessionAuthorization } from "../src/modules/secrets/secrets.auth.js";
import type { Env } from "../src/internal-types/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "../migrations");

function migrationStatements(path: string): string[] {
  let content = readFileSync(path, "utf-8");
  content = content.replace(/^PRAGMA\s+foreign_keys\s*=\s*ON;$/gim, "");
  content = content.replace(/--[^\n]*/g, "");

  return content
    .split(";")
    .map((stmt) => stmt.trim())
    .filter(Boolean)
    .map((stmt) => stmt.replace(/\s+/g, " "));
}

async function createDb(): Promise<{ db: D1Database; dispose: () => Promise<void> }> {
  const mf = new Miniflare({
    script: "export default { fetch() { return new Response('ok'); } }",
    modules: true,
    d1Databases: ["DB"],
  });
  const db = await mf.getD1Database("DB");
  const migrationFiles = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort();

  for (const file of migrationFiles) {
    for (const statement of migrationStatements(join(MIGRATIONS_DIR, file))) {
      await db.exec(`${statement};`);
    }
  }

  return { db, dispose: () => mf.dispose() };
}

async function createWorkspace(db: D1Database, workspaceId = "workspace-1"): Promise<void> {
  const now = Date.now();
  await db
    .prepare(
      `
        INSERT INTO workspaces (id, slug, name, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `
    )
    .bind(workspaceId, workspaceId, "Test Workspace", now, now)
    .run();
}

async function createSession(
  db: D1Database,
  status: "idle" | "closed" = "idle"
): Promise<void> {
  await new SessionRepository(db).save({
    id: "session-1",
    workspaceId: "workspace-1",
    workflowId: "workflow-1",
    status,
    nextEventCursor: "0",
    updatedAt: Date.now(),
  });
}

describe("session secret authorization", () => {
  it("authorizes live sessions for their workspace", async () => {
    const { db, dispose } = await createDb();
    try {
      await createWorkspace(db);
      await createSession(db);

      const result = await validateSessionAuthorization({ DB: db } as Env, "session-1");

      expect(result).toEqual({
        valid: true,
        result: {
          userId: "",
          workspaceId: "workspace-1",
          isSessionAuth: true,
        },
      });
    } finally {
      await dispose();
    }
  });

  it("rejects closed sessions", async () => {
    const { db, dispose } = await createDb();
    try {
      await createWorkspace(db);
      await createSession(db, "closed");

      await expect(validateSessionAuthorization({ DB: db } as Env, "session-1")).resolves.toEqual({
        valid: false,
        error: "Session is not active",
      });
    } finally {
      await dispose();
    }
  });

  it("rejects missing sessions", async () => {
    const { db, dispose } = await createDb();
    try {
      await expect(validateSessionAuthorization({ DB: db } as Env, "missing")).resolves.toEqual({
        valid: false,
        error: "Session not found",
      });
    } finally {
      await dispose();
    }
  });
});
