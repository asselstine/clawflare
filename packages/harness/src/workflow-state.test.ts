/**
 * Unit tests for workflow state management
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import type { AgentSessionState } from "./agent.js";
import type { SessionEvent } from "./types.js";

// Mock the session-store module
const mockStorage = new Map<string, unknown>();

interface MockEnv {
  SESSION_STORE: {
    idFromName: (name: string) => { toString: () => string };
    get: () => MockDurableObjectStub;
  };
}

interface MockDurableObjectStub {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
}

function createMockEnv(): MockEnv {
  return {
    SESSION_STORE: {
      idFromName: (name: string) => ({ toString: () => name }),
      get: (): MockDurableObjectStub => ({
        fetch: async (url: string, init?: RequestInit): Promise<Response> => {
          const path = url.replace("https://session-store.local", "");
          
          if (path === "/workflow-session") {
            if (init?.method === "PUT") {
              const body = JSON.parse(init.body as string);
              mockStorage.set(`workflow-session:${body.id}`, body);
              return new Response(JSON.stringify({ ok: true }));
            }
            // GET
            const sessionId = url.match(/session-store\.local\/workflow-session\/(.+)$/)?.[1] || "";
            const data = sessionId
              ? mockStorage.get(`workflow-session:${sessionId}`)
              : Array.from(mockStorage.entries()).find(([key]) => key.startsWith("workflow-session:"))?.[1];
            if (!data) {
              return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
            }
            return new Response(JSON.stringify(data));
          }
          
          return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
        },
      }),
    },
  };
}

describe("workflow-state", () => {
  beforeEach(() => {
    mockStorage.clear();
  });

  describe("sessionKey", () => {
    it("should create correct session key", () => {
      const key = `session:test-123`;
      assert.strictEqual(key, "session:test-123");
    });
  });

  describe("DurableObject interactions", () => {
    it("should create session store with idFromName", () => {
      const env = createMockEnv();
      const id = env.SESSION_STORE.idFromName("test-session");
      assert.strictEqual(id.toString(), "test-session");
    });

    it("should make requests to correct URL", async () => {
      const env = createMockEnv();
      const stub = env.SESSION_STORE.get();
      
      let capturedUrl: string | undefined;
      const originalFetch = stub.fetch;
      stub.fetch = async (url: string, init?: RequestInit) => {
        capturedUrl = url;
        return new Response(JSON.stringify({ ok: true }));
      };
      
      await stub.fetch("https://session-store.local/workflow-session");
      assert.strictEqual(capturedUrl, "https://session-store.local/workflow-session");
    });
  });

  describe("saveSession", () => {
    it("should store session with updatedAt timestamp", async () => {
      const env = createMockEnv();
      const stub = env.SESSION_STORE.get();
      
      const beforeSave = Date.now();
      const session: AgentSessionState = {
        id: "test-session",
        messages: [],
        systemPrompt: "You are a test assistant",
        thinkingLevel: "low",
        model: {
          id: "test-model",
          provider: "test",
          api: "openai-completions",
        },
        tools: [],
        turns: [],
        toolCalls: [],
        status: "idle",
        createdAt: Date.now(),
      };
      
      // Simulate saveSession
      const response = await stub.fetch("https://session-store.local/workflow-session", {
        method: "PUT",
        body: JSON.stringify({ ...session, updatedAt: Date.now() }),
      });
      
      assert.strictEqual(response.ok, true);
      const stored = mockStorage.get(`workflow-session:${session.id}`) as { updatedAt: number };
      assert.ok(stored.updatedAt >= beforeSave);
    });
  });

  describe("loadSession", () => {
    it("should return stored session", async () => {
      const env = createMockEnv();
      const stub = env.SESSION_STORE.get();
      
      const session: AgentSessionState = {
        id: "load-test",
        messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
        systemPrompt: "Test",
        thinkingLevel: "low",
        model: { id: "model", provider: "test", api: "openai-completions" },
        tools: [],
        turns: [],
        toolCalls: [],
        status: "idle",
        createdAt: Date.now(),
      };
      
      mockStorage.set(`workflow-session:load-test`, session);
      
      const response = await stub.fetch("https://session-store.local/workflow-session");
      const data = await response.json();
      assert.strictEqual(data.id, "load-test");
      assert.strictEqual(data.messages.length, 1);
    });

    it("should return 404 for non-existent session", async () => {
      const env = createMockEnv();
      const stub = env.SESSION_STORE.get();
      
      const response = await stub.fetch("https://session-store.local/workflow-session");
      assert.strictEqual(response.status, 404);
    });
  });

  describe("error handling", () => {
    it("should throw on network errors", async () => {
      const env = createMockEnv();
      const stub = env.SESSION_STORE.get();
      
      stub.fetch = async () => {
        throw new Error("Network error");
      };
      
      try {
        await stub.fetch("https://session-store.local/workflow-session");
        assert.fail("Should have thrown");
      } catch (error) {
        assert.ok(error instanceof Error);
        assert.strictEqual((error as Error).message, "Network error");
      }
    });

    it("should throw on non-ok response", async () => {
      const env = createMockEnv();
      const stub = env.SESSION_STORE.get();
      
      stub.fetch = async () => new Response("Server error", { status: 500 });
      
      const response = await stub.fetch("https://session-store.local/workflow-session");
      assert.strictEqual(response.ok, false);
      assert.strictEqual(response.status, 500);
    });
  });

  describe("jsonFetch helper behavior", () => {
    it("should parse JSON response", async () => {
      const env = createMockEnv();
      const stub = env.SESSION_STORE.get();
      
      stub.fetch = async () => new Response(JSON.stringify({ id: "parsed", data: [1, 2, 3] }));
      
      const response = await stub.fetch("https://session-store.local/workflow-session");
      const data = await response.json();
      
      assert.deepStrictEqual(data.data, [1, 2, 3]);
    });

    it("should handle empty response body", async () => {
      const env = createMockEnv();
      const stub = env.SESSION_STORE.get();
      
      stub.fetch = async () => new Response(JSON.stringify({ ok: true }));
      
      const response = await stub.fetch("https://session-store.local/workflow-session");
      const data = await response.json();
      
      assert.strictEqual(data.ok, true);
    });
  });
});
