import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";
import { ContainerRepository } from "../../../src/data/containers.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "../../../migrations");

function migrationStatements(migrationFile: string): string[] {
  let content = readFileSync(join(MIGRATIONS_DIR, migrationFile), "utf-8");
  content = content.replace(/^PRAGMA\s+foreign_keys\s*=\s*ON;$/gim, "");
  content = content.replace(/--[^\n]*/g, "");
  return content
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean)
    .map((statement) => statement.replace(/\s+/g, " "));
}

async function applyMigrations(db: D1Database): Promise<void> {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith(".sql"))
    .sort();
  for (const file of files) {
    for (const statement of migrationStatements(file)) {
      await db.exec(`${statement};`);
    }
  }
}

async function seedWorkspaceAndSession(db: D1Database): Promise<void> {
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO workspaces (id, slug, name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .bind("workspace-1", "workspace-1", "Workspace", now, now)
    .run();
  await db
    .prepare(
      `INSERT INTO sessions (
        id, workflow_id, workspace_id, status, next_event_cursor, updated_at, max_queue_size
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind("session-1", "workflow-1", "workspace-1", "idle", 0, now, 100)
    .run();
  await db
    .prepare(
      `INSERT INTO sessions (
        id, workflow_id, workspace_id, status, next_event_cursor, updated_at, max_queue_size
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind("session-2", "workflow-2", "workspace-1", "idle", 0, now + 1, 100)
    .run();
}

describe("ContainerRepository", () => {
  it("creates containers and links them to sessions through session_container", async () => {
    const mf = new Miniflare({
      script: "export default { fetch() { return new Response('ok'); } }",
      modules: true,
      d1Databases: ["DB"],
    });

    try {
      const db = await mf.getD1Database("DB");
      await applyMigrations(db);
      await seedWorkspaceAndSession(db);

      const containers = new ContainerRepository(db);
      const container = await containers.create({
        id: "container-1",
        workspaceId: "workspace-1",
        description: "test container",
      });
      const link = await containers.linkSession({
        workspaceId: "workspace-1",
        sessionId: "session-1",
        containerId: "container-1",
        role: "attached",
      });

      expect(container.id).toBe("container-1");
      expect(container.description).toBe("test container");
      expect(link.sessionId).toBe("session-1");
      expect(link.containerId).toBe("container-1");

      const sessionContainers = await containers.listForSession("workspace-1", "session-1");
      expect(sessionContainers.map((item) => item.id)).toEqual(["container-1"]);

      await containers.markDestroyed("workspace-1", "container-1");

      expect((await containers.get("workspace-1", "container-1"))?.status).toBe("destroyed");
      expect((await containers.listForSession("workspace-1", "session-1")).map((item) => item.id)).toEqual(["container-1"]);
    } finally {
      await mf.dispose();
    }
  });

  it("returns the newest session link first for container-scoped outbound context", async () => {
    const mf = new Miniflare({
      script: "export default { fetch() { return new Response('ok'); } }",
      modules: true,
      d1Databases: ["DB"],
    });

    try {
      const db = await mf.getD1Database("DB");
      await applyMigrations(db);
      await seedWorkspaceAndSession(db);

      const containers = new ContainerRepository(db);
      await containers.create({
        id: "container-1",
        workspaceId: "workspace-1",
      });
      await containers.linkSession({
        workspaceId: "workspace-1",
        sessionId: "session-1",
        containerId: "container-1",
      });
      await containers.linkSession({
        workspaceId: "workspace-1",
        sessionId: "session-2",
        containerId: "container-1",
      });

      const links = await containers.listLinksForContainerId("container-1");

      expect(links.map((link) => link.sessionId)).toEqual(["session-2", "session-1"]);
    } finally {
      await mf.dispose();
    }
  });
});
