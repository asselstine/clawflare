import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";
import { handleCreateProvider, handleDeleteProvider, handleListProviderModels, handleListProviders } from "../src/modules/providers/providers.routes.js";
import { validateModelInput } from "../src/modules/models/models.validation.js";
import { getModelsForProvider } from "../src/modules/providers/providers.catalog.js";
import type { Env } from "../src/internal-types/index.js";
import type { RequestContext } from "../src/http/request-context.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "../migrations");

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
    for (const statement of executableMigrationStatements(join(MIGRATIONS_DIR, file))) {
      await db.exec(`${statement};`);
    }
  }

  return { db, dispose: () => mf.dispose() };
}

function createSecretBroker(): Fetcher {
  return {
    async fetch(_request: Request): Promise<Response> {
      return Response.json({ ok: true });
    },
  } as Fetcher;
}

function createRequestContext(): RequestContext {
  return {
    user: {
      id: "user-1",
      email: "user@example.com",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
    workspace: {
      id: "workspace-1",
      slug: "workspace",
      name: "Workspace",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
    role: "owner",
    accessTokenId: "token-1",
  };
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

describe("providers routes", () => {
  it("lists providers with server-defined secrets", async () => {
    const response = await handleListProviders();

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      providers: Array<{ id: string; requiredSecrets: string[] }>;
    };
    const bedrock = body.providers.find((provider) => provider.id === "amazon-bedrock");

    expect(bedrock?.requiredSecrets).toEqual(["AWS_BEARER_TOKEN_BEDROCK"]);
  });

  it("lists models under the selected provider", async () => {
    const response = await handleListProviderModels("amazon-bedrock");

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      provider: string;
      models: Array<{ id: string; provider: string }>;
    };

    expect(body.provider).toBe("amazon-bedrock");
    expect(body.models.length).toBeGreaterThan(10);
    expect(body.models.every((model) => model.provider === "amazon-bedrock")).toBe(true);
  });

  it("rejects unknown models for a provider", () => {
    const result = validateModelInput({
      provider: "amazon-bedrock",
      modelName: "not-a-real-bedrock-model",
      secrets: {
        AWS_BEARER_TOKEN_BEDROCK: "token",
      },
    });

    expect(result).toEqual({
      ok: false,
      error: 'Unknown model "not-a-real-bedrock-model" for provider "amazon-bedrock"',
    });
  });

  it("creates a provider and optional default model through POST /v1/providers", async () => {
    const { db, dispose } = await createDb();
    try {
      const requestContext = createRequestContext();
      await seedWorkspace(db, requestContext);
      const modelName = getModelsForProvider("amazon-bedrock")[0]?.id;
      expect(modelName).toBeTruthy();

      const response = await handleCreateProvider(
        new Request("https://example.com/v1/providers", {
          method: "POST",
          body: JSON.stringify({
            provider: "amazon-bedrock",
            secrets: {
              AWS_BEARER_TOKEN_BEDROCK: "token",
            },
            defaultModelName: modelName,
            setAsDefault: true,
          }),
          headers: {
            "Content-Type": "application/json",
          },
        }),
        { DB: db, SECRET_BROKER: createSecretBroker() } as Env,
        requestContext
      );

      expect(response.status).toBe(201);
      const body = (await response.json()) as {
        provider: { id: string; provider: string };
        model?: { id: string; modelName: string; providerId: string };
        defaultModelId?: string;
      };
      expect(body.provider.provider).toBe("amazon-bedrock");
      expect(body.model?.modelName).toBe(modelName);
      expect(body.model?.providerId).toBe(body.provider.id);
      expect(body.defaultModelId).toBe(body.model?.id);

      const workspace = await db
        .prepare("SELECT default_model_id FROM workspaces WHERE id = ?")
        .bind(requestContext.workspace.id)
        .first<{ default_model_id: string | null }>();
      expect(workspace?.default_model_id).toBe(body.model?.id);
    } finally {
      await dispose();
    }
  });

  it("deletes a provider, associated models, and workspace default", async () => {
    const { db, dispose } = await createDb();
    try {
      const requestContext = createRequestContext();
      await seedWorkspace(db, requestContext);
      const modelName = getModelsForProvider("amazon-bedrock")[0]?.id;
      expect(modelName).toBeTruthy();

      const createResponse = await handleCreateProvider(
        new Request("https://example.com/v1/providers", {
          method: "POST",
          body: JSON.stringify({
            provider: "amazon-bedrock",
            secrets: {
              AWS_BEARER_TOKEN_BEDROCK: "token",
            },
            defaultModelName: modelName,
            setAsDefault: true,
          }),
          headers: {
            "Content-Type": "application/json",
          },
        }),
        { DB: db, SECRET_BROKER: createSecretBroker() } as Env,
        requestContext
      );
      const created = (await createResponse.json()) as {
        provider: { id: string };
        model: { id: string };
      };

      const deleteResponse = await handleDeleteProvider(
        { DB: db } as Env,
        requestContext,
        created.provider.id
      );

      expect(deleteResponse.status).toBe(200);
      const deleted = (await deleteResponse.json()) as {
        ok: boolean;
        providerId: string;
        deletedModelIds: string[];
        clearedDefaultModelId?: string;
      };
      expect(deleted).toMatchObject({
        ok: true,
        providerId: created.provider.id,
        deletedModelIds: [created.model.id],
        clearedDefaultModelId: created.model.id,
      });

      const providerRow = await db
        .prepare("SELECT deleted_at FROM providers WHERE id = ?")
        .bind(created.provider.id)
        .first<{ deleted_at: number | null }>();
      const modelRow = await db
        .prepare("SELECT deleted_at FROM models WHERE id = ?")
        .bind(created.model.id)
        .first<{ deleted_at: number | null }>();
      const workspace = await db
        .prepare("SELECT default_model_id FROM workspaces WHERE id = ?")
        .bind(requestContext.workspace.id)
        .first<{ default_model_id: string | null }>();

      expect(providerRow?.deleted_at).toBeTypeOf("number");
      expect(modelRow?.deleted_at).toBeTypeOf("number");
      expect(workspace?.default_model_id).toBeNull();
    } finally {
      await dispose();
    }
  });
});
