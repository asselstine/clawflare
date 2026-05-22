import { describe, expect, it } from "vitest";
import { handleCreateSession } from "../../../src/http/routes/session-create.js";
import type { Env } from "../../../src/internal-types/index.js";

// Mock environment and dependencies
function createMockEnv(): Env {
  return {
    DB: {
      prepare: () => ({
        bind: () => ({
          run: () => Promise.resolve({}),
          first: () => Promise.resolve(null),
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
    API_TOKEN: "test-token",
  } as unknown as Env;
}

interface CreateSessionResponse {
  id: string;
  messages: unknown[];
  createdAt: number;
}

describe("handleCreateSession", () => {
  it("creates a new session with generated ID when no sessionId provided", async () => {
    const env = createMockEnv();
    const request = new Request("http://localhost/v1/session", {
      method: "POST",
      body: JSON.stringify({}),
    });

    const response = await handleCreateSession(request, env);
    const data = await response.json() as CreateSessionResponse;

    expect(response.status).toBe(200);
    expect(data.id).toBeDefined();
    expect(data.id).toMatch(/^[0-9a-f-]{36}$/); // UUID format
    expect(data.messages).toEqual([]);
    expect(data.createdAt).toBeDefined();
  });

  it("creates a new session with provided sessionId", async () => {
    const env = createMockEnv();
    const customId = "custom-session-id-123";
    const request = new Request("http://localhost/v1/session", {
      method: "POST",
      body: JSON.stringify({ sessionId: customId }),
    });

    const response = await handleCreateSession(request, env);
    const data = await response.json() as CreateSessionResponse;

    expect(response.status).toBe(200);
    expect(data.id).toBe(customId);
  });

  it("handles empty body gracefully", async () => {
    const env = createMockEnv();
    const request = new Request("http://localhost/v1/session", {
      method: "POST",
      body: "",
    });

    const response = await handleCreateSession(request, env);
    const data = await response.json() as CreateSessionResponse;

    expect(response.status).toBe(200);
    expect(data.id).toBeDefined();
    expect(data.messages).toEqual([]);
  });
});
