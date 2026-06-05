import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";
import secretBroker from "../src/modules/secrets/secret-broker.worker.js";
import { encodeBase64, generateKEK } from "../src/modules/secrets/secrets.crypto.js";
import type { Env } from "../src/internal-types/index.js";
import type { AuthorizationContext } from "../src/modules/secrets/secrets.types.js";

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

async function createAuthorizedWorkspace(db: D1Database): Promise<void> {
  const now = Date.now();
  await db
    .prepare(
      `
        INSERT INTO users (id, email, display_name, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `
    )
    .bind("user-1", "user@example.com", "Test User", now, now)
    .run();
  await db
    .prepare(
      `
        INSERT INTO workspaces (id, slug, name, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `
    )
    .bind("workspace-1", "workspace-1", "Test Workspace", now, now)
    .run();
  await db
    .prepare(
      `
        INSERT INTO workspace_memberships (workspace_id, user_id, role, joined_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `
    )
    .bind("workspace-1", "user-1", "owner", now, now)
    .run();
}

function authContext(): AuthorizationContext {
  return {
    userId: "user-1",
    workspaceId: "workspace-1",
    authTime: Date.now(),
    requestId: "request-1",
    version: 1,
  };
}

function post(path: string, body: unknown): Request {
  return new Request(`https://secret-broker${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("secret broker", () => {
  it("stores and retrieves envelope-encrypted secrets with a bound KEK", async () => {
    const { db, dispose } = await createDb();
    try {
      await createAuthorizedWorkspace(db);
      const env = {
        DB: db,
        CLAWFLARE_KEK: encodeBase64(generateKEK()),
      } as Env;

      const storeResponse = await secretBroker.fetch(
        post("/store", {
          auth: authContext(),
          key: "providers/provider-1/AWS_BEARER_TOKEN_BEDROCK",
          value: "bedrock-token",
        }),
        env
      );

      await expect(storeResponse.json()).resolves.toEqual({ ok: true });

      const encryptedRecord = await db
        .prepare("SELECT ct FROM encrypted_secrets WHERE workspace_id = ? AND key = ?")
        .bind("workspace-1", "providers/provider-1/AWS_BEARER_TOKEN_BEDROCK")
        .first<{ ct: string }>();
      expect(encryptedRecord?.ct).toBeTruthy();
      expect(encryptedRecord?.ct).not.toContain("bedrock-token");

      const getResponse = await secretBroker.fetch(
        post("/get", {
          auth: authContext(),
          key: "providers/provider-1/AWS_BEARER_TOKEN_BEDROCK",
        }),
        env
      );

      await expect(getResponse.json()).resolves.toEqual({
        ok: true,
        value: "bedrock-token",
      });
    } finally {
      await dispose();
    }
  });

  it("retrieves workspace secrets with workspace-scoped service authorization", async () => {
    const { db, dispose } = await createDb();
    try {
      await createAuthorizedWorkspace(db);
      const env = {
        DB: db,
        CLAWFLARE_KEK: encodeBase64(generateKEK()),
      } as Env;

      const storeResponse = await secretBroker.fetch(
        post("/store", {
          auth: authContext(),
          key: "workspaces_workspace-1_egress_github_GITHUB_TOKEN",
          value: "github-token",
        }),
        env
      );
      await expect(storeResponse.json()).resolves.toEqual({ ok: true });

      const getResponse = await secretBroker.fetch(
        post("/get", {
          auth: { workspaceId: "workspace-1" },
          key: "workspaces_workspace-1_egress_github_GITHUB_TOKEN",
        }),
        env
      );

      await expect(getResponse.json()).resolves.toEqual({
        ok: true,
        value: "github-token",
      });
    } finally {
      await dispose();
    }
  });

  it("fails clearly when the KEK binding is missing", async () => {
    const { db, dispose } = await createDb();
    try {
      const response = await secretBroker.fetch(post("/get", {}), { DB: db } as Env);

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({
        ok: false,
        error: "Failed to load KEK: CLAWFLARE_KEK secret binding not configured",
      });
    } finally {
      await dispose();
    }
  });
});
