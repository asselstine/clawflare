import { describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";
import type { Env } from "../../src/internal-types/index.js";
import { EgressHandlerRepository } from "../../src/data/egress-handlers.js";

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class WorkerEntrypoint {},
}));

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "../../migrations");

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

describe("routeOutboundRequest", () => {
  it("routes Cloudflare API requests through the Cloudflare egress handler", async () => {
    const { routeOutboundRequest } = await import("../../src/egress/gateway.js");
    const { db, dispose } = await createDb();
    try {
      const response = await routeOutboundRequest(
        {
          DB: db,
          MOCK_EGRESS: "true",
          CLOUDFLARE_API_TOKEN: "test-token",
        } as unknown as Env,
        new Request("https://api.cloudflare.com/client/v4/accounts"),
        "test-request"
      );
      const data = (await response.json()) as {
        ok: boolean;
        handler?: string;
        url?: string;
      };

      expect(response.status).toBe(200);
      expect(data.ok).toBe(true);
      expect(data.handler).toBe("cloudflare");
      expect(data.url).toBe("https://api.cloudflare.com/client/v4/accounts");
    } finally {
      await dispose();
    }
  });

  it("resolves configured egress secrets with workspace-scoped authorization", async () => {
    const { routeOutboundRequest } = await import("../../src/egress/gateway.js");
    const { db, dispose } = await createDb();
    const brokerRequests: unknown[] = [];
    try {
      const now = Date.now();
      await db.prepare(
        "INSERT INTO workspaces (id, slug, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
      ).bind("workspace-1", "workspace-1", "Workspace 1", now, now).run();
      await new EgressHandlerRepository(db).upsert({
        workspaceId: "workspace-1",
        egressHandlerId: "cloudflare",
        name: "cloudflare",
        description: "Cloudflare",
        domains: ["api.cloudflare.com"],
        enabled: true,
        secretRefs: { CLOUDFLARE_API_TOKEN: "workspaces_workspace-1_egress_cloudflare_CLOUDFLARE_API_TOKEN" },
        config: {},
      });

      const secretBroker = {
        async fetch(_input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
          brokerRequests.push(JSON.parse(String(init?.body)));
          return Response.json({ ok: true, value: "workspace-token" });
        },
      } as Fetcher;

      const response = await routeOutboundRequest(
        {
          DB: db,
          MOCK_EGRESS: "true",
          SECRET_BROKER: secretBroker,
        } as unknown as Env,
        new Request("https://api.cloudflare.com/client/v4/accounts"),
        "test-request",
        { workspaceId: "workspace-1" }
      );

      expect(response.status).toBe(200);
      expect(brokerRequests).toEqual([
        {
          auth: { workspaceId: "workspace-1" },
          key: "workspaces_workspace-1_egress_cloudflare_CLOUDFLARE_API_TOKEN",
        },
      ]);
    } finally {
      await dispose();
    }
  });
});
