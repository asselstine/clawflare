import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";
import {
  handleConfigureEgressHandler,
  handleGetEgressHandler,
  handleListAvailableEgressHandlers,
  handleListEgressHandlers,
  handleUpdateEgressHandler,
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

async function seedWorkspace(db: D1Database, ctx: RequestContext): Promise<void> {
  const now = Date.now();
  await db.prepare(
    "INSERT OR IGNORE INTO users (id, email, created_at, updated_at) VALUES (?, ?, ?, ?)"
  ).bind(ctx.user.id, ctx.user.email, now, now).run();
  await db.prepare(
    "INSERT OR IGNORE INTO workspaces (id, slug, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
  ).bind(ctx.workspace.id, ctx.workspace.slug, ctx.workspace.name, now, now).run();
  await db.prepare(
    "INSERT OR IGNORE INTO workspace_memberships (workspace_id, user_id, role, joined_at, updated_at) VALUES (?, ?, ?, ?, ?)"
  ).bind(ctx.workspace.id, ctx.user.id, ctx.role, now, now).run();
}

function createSecretBroker(): Fetcher {
  return {
    async fetch(_request: Request): Promise<Response> {
      return Response.json({ ok: true });
    },
  } as Fetcher;
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
  it("lists available egress handlers with secret requirements", async () => {
    const response = handleListAvailableEgressHandlers();
    const data = (await response.json()) as {
      egressHandlers: Array<{
        egressHandlerId: string;
        name: string;
        requiredSecrets: string[];
        optionalSecrets: string[];
      }>;
    };

    expect(response.status).toBe(200);
    expect(data.egressHandlers.find((handler) => handler.egressHandlerId === "cloudflare")?.requiredSecrets)
      .toContain("CLOUDFLARE_API_TOKEN");
    expect(data.egressHandlers.find((handler) => handler.egressHandlerId === "github")?.optionalSecrets)
      .toContain("GITHUB_TOKEN");
  });

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
          egressHandlerId: string;
          domains: string[];
          config?: unknown;
        }>;
      };

      expect(response.status).toBe(200);
      expect(data.egressHandlers.map((handler) => handler.egressHandlerId)).toContain(
        "cloudflare"
      );
      const cloudflare = data.egressHandlers.find(
        (handler) => handler.egressHandlerId === "cloudflare"
      );
      expect(cloudflare?.name).toBe("Cloudflare");
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
          egressHandlerId: string;
          domains: string[];
          enabled: boolean;
        };
      };

      expect(response.status).toBe(200);
      expect(data.egressHandler.egressHandlerId).toBe("cloudflare");
      expect(data.egressHandler.name).toBe("Cloudflare");
      expect(data.egressHandler.domains).toEqual(["api.cloudflare.com"]);
      expect(data.egressHandler.enabled).toBe(true);
    } finally {
      await dispose();
    }
  });

  it("configures an egress handler without exposing secret refs or config values", async () => {
    const { db, dispose } = await createDb();
    const ctx = createRequestContext();
    await seedWorkspace(db, ctx);

    try {
      const response = await handleConfigureEgressHandler(
        new Request("https://example.com/v1/egress-handlers", {
          method: "POST",
          body: JSON.stringify({
            egressHandlerId: "cloudflare",
            secrets: { CLOUDFLARE_API_TOKEN: "secret-token" },
            enabled: true,
          }),
        }),
        { DB: db, SECRET_BROKER: createSecretBroker() } as Env,
        ctx
      );
      const data = (await response.json()) as {
        egressHandler: {
          name: string;
          egressHandlerId: string;
          configuredSecrets: string[];
          requiredSecrets: string[];
          config?: unknown;
          secretRefs?: unknown;
        };
      };

      expect(response.status).toBe(201);
      expect(data.egressHandler.egressHandlerId).toBe("cloudflare");
      expect(data.egressHandler.name).toBe("Cloudflare");
      expect(data.egressHandler.configuredSecrets).toEqual(["CLOUDFLARE_API_TOKEN"]);
      expect(data.egressHandler.requiredSecrets).toEqual(["CLOUDFLARE_API_TOKEN"]);
      expect(data.egressHandler).not.toHaveProperty("config");
      expect(data.egressHandler).not.toHaveProperty("secretRefs");
    } finally {
      await dispose();
    }
  });

  it("disables a configured egress handler", async () => {
    const { db, dispose } = await createDb();
    const ctx = createRequestContext();
    await seedWorkspace(db, ctx);

    try {
      await handleConfigureEgressHandler(
        new Request("https://example.com/v1/egress-handlers", {
          method: "POST",
          body: JSON.stringify({
            egressHandlerId: "github",
            secrets: { GITHUB_TOKEN: "ghp_secret" },
            enabled: true,
          }),
        }),
        { DB: db, SECRET_BROKER: createSecretBroker() } as Env,
        ctx
      );

      const response = await handleUpdateEgressHandler(
        new Request("https://example.com/v1/egress-handlers/github", {
          method: "PATCH",
          body: JSON.stringify({ enabled: false }),
        }),
        { DB: db, SECRET_BROKER: createSecretBroker() } as Env,
        ctx,
        "github"
      );
      const data = (await response.json()) as {
        egressHandler: { egressHandlerId: string; name: string; enabled: boolean };
      };

      expect(response.status).toBe(200);
      expect(data.egressHandler.egressHandlerId).toBe("github");
      expect(data.egressHandler.name).toBe("GitHub");
      expect(data.egressHandler.enabled).toBe(false);
    } finally {
      await dispose();
    }
  });

  it("finds configured egress handlers with surrounding wildcard queries", async () => {
    const { db, dispose } = await createDb();
    const ctx = createRequestContext();
    await seedWorkspace(db, ctx);

    try {
      await handleConfigureEgressHandler(
        new Request("https://example.com/v1/egress-handlers", {
          method: "POST",
          body: JSON.stringify({
            egressHandlerId: "github",
            secrets: { GITHUB_TOKEN: "ghp_secret" },
            enabled: true,
          }),
        }),
        { DB: db, SECRET_BROKER: createSecretBroker() } as Env,
        ctx
      );

      const response = await handleListEgressHandlers(
        { DB: db } as Env,
        new URL("https://example.com/v1/egress-handlers?q=*github*"),
        ctx
      );
      const data = (await response.json()) as {
        egressHandlers: Array<{ egressHandlerId: string; name: string }>;
      };

      expect(response.status).toBe(200);
      expect(data.egressHandlers.map((handler) => handler.egressHandlerId)).toContain("github");
    } finally {
      await dispose();
    }
  });
});
