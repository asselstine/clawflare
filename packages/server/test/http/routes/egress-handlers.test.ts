import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";
import {
  handleGetEgressHandler,
  handleListEgressHandlers,
} from "../../../src/modules/egress-handlers/egress-handlers.routes.js";
import type { Env } from "../../../src/internal-types/index.js";
import type { RequestContext } from "../../../src/http/request-context.js";
import type { Workspace } from "../../../src/data/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "../../../migrations");

function executableMigrationStatements(path: string): string[] {
  let content = readFileSync(path, "utf-8");
  content = content.replace(/^PRAGMA\s+foreign_keys\s*=\s*ON;$/gim, "");
  content = content.replace(/--[^\n]*/g, "");
  return content
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0)
    .map((statement) => statement.replace(/\s+/g, " "));
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
    for (const statement of executableMigrationStatements(
      join(MIGRATIONS_DIR, file)
    )) {
      await db.exec(`${statement};`);
    }
  }

  return { db, dispose: () => mf.dispose() };
}

function createRequestContext(): RequestContext {
  const workspace: Workspace = {
    id: "test-workspace",
    slug: "test",
    name: "Test Workspace",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  return {
    user: {
      id: "test-user",
      email: "test@example.com",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
    workspace,
    role: "owner",
  };
}

describe("egress handler routes", () => {
  it("lists built-in egress handlers without exposing config", async () => {
    const { db, dispose } = await createDb();
    try {
      const response = await handleListEgressHandlers(
        { DB: db } as Env,
        new URL("https://example.com/v1/egress-handlers"),
        createRequestContext()
      );
      const data = (await response.json()) as {
        egressHandlers: Array<{
          name: string;
          domains: string[];
          config?: unknown;
        }>;
      };

      expect(response.status).toBe(200);
      expect(data.egressHandlers.map((handler) => handler.name)).toContain(
        "cloudflare"
      );
      const cloudflare = data.egressHandlers.find(
        (handler) => handler.name === "cloudflare"
      );
      expect(cloudflare?.domains).toEqual(["api.cloudflare.com"]);
      expect(cloudflare).not.toHaveProperty("config");
    } finally {
      await dispose();
    }
  });

  it("returns a single built-in egress handler by name", async () => {
    const { db, dispose } = await createDb();
    try {
      const response = await handleGetEgressHandler(
        { DB: db } as Env,
        createRequestContext(),
        "cloudflare"
      );
      const data = (await response.json()) as {
        egressHandler: {
          name: string;
          domains: string[];
          enabled: boolean;
        };
      };

      expect(response.status).toBe(200);
      expect(data.egressHandler.name).toBe("cloudflare");
      expect(data.egressHandler.domains).toEqual(["api.cloudflare.com"]);
      expect(data.egressHandler.enabled).toBe(true);
    } finally {
      await dispose();
    }
  });
});
