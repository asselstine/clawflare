import { describe, expect, it } from "vitest";
import { handleCreateSession } from "../../../src/modules/sessions/sessions.routes.js";
import type { Env } from "../../../src/internal-types/index.js";
import type { RequestContext } from "../../../src/http/request-context.js";
import type { Workspace } from "../../../src/data/index.js";

// Mock environment and dependencies
function createMockEnv(): Env {
  return {
    DB: {
      prepare: (query: string) => ({
        bind: () => ({
          run: () => Promise.resolve({}),
          first: () =>
            Promise.resolve(
              query.includes("workflow_waiting_at")
                ? { workflow_waiting_at: Date.now() }
                : null
            ),
          all: () => Promise.resolve({ results: [] }),
        }),
      }),
      batch: () => Promise.resolve([]),
      exec: () => Promise.resolve({ count: 0, duration: 0 }),
      dump: () => Promise.resolve(new ArrayBuffer(0)),
    } as unknown as Env["DB"],
    AGENT_WORKFLOW: {
      create: () => Promise.resolve({}),
      get: () => ({
        fetch: () => Promise.resolve(new Response()),
        sendEvent: () => Promise.resolve(),
      }),
    } as unknown as Env["AGENT_WORKFLOW"],
  } as unknown as Env;
}

function createMockRequestContext(): RequestContext {
  const workspace: Workspace = {
    id: "default-workspace",
    slug: "default",
    name: "Default Workspace",
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

interface CreateSessionResponse {
  id: string;
  eventCursor: string;
  createdAt: number;
  workspaceId?: string;
}

describe("handleCreateSession", () => {
  it("creates a new session with generated ID when no sessionId provided", async () => {
    const env = createMockEnv();
    const requestContext = createMockRequestContext();
    const request = new Request("http://localhost/v1/session", {
      method: "POST",
      body: JSON.stringify({}),
    });

    const response = await handleCreateSession(request, env, requestContext, 0);
    const data = await response.json() as CreateSessionResponse;

    expect(response.status).toBe(200);
    expect(data.id).toBeDefined();
    expect(data.id).toMatch(/^[0-9a-f-]{36}$/); // UUID format
    expect(data.eventCursor).toBeDefined();
    expect(data.createdAt).toBeDefined();
    expect(data.workspaceId).toBe("default-workspace");
  });

  it("creates a new session with provided sessionId", async () => {
    const env = createMockEnv();
    const requestContext = createMockRequestContext();
    const customId = "custom-session-id-123";
    const request = new Request("http://localhost/v1/session", {
      method: "POST",
      body: JSON.stringify({ sessionId: customId }),
    });

    const response = await handleCreateSession(request, env, requestContext, 0);
    const data = await response.json() as CreateSessionResponse;

    expect(response.status).toBe(200);
    expect(data.id).toBe(customId);
  });

  it("handles empty body gracefully", async () => {
    const env = createMockEnv();
    const requestContext = createMockRequestContext();
    const request = new Request("http://localhost/v1/session", {
      method: "POST",
      body: "",
    });

    const response = await handleCreateSession(request, env, requestContext, 0);
    const data = await response.json() as CreateSessionResponse;

    expect(response.status).toBe(200);
    expect(data.id).toBeDefined();
    expect(data.eventCursor).toBeDefined();
  });
});
