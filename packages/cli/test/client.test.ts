import { describe, expect, it, vi } from "vitest";
import { AgentClient } from "../src/client.js";

describe("AgentClient", () => {
  // Helper to create a mock fetch response
  function createMockResponse(body: unknown, status = 200): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(JSON.stringify(body)),
    } as Response;
  }

  describe("createSession", () => {
    it("should create a new session via POST /v1/session", async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        createMockResponse({
          id: "test-session-id",
          workspaceId: "workspace-id",
          eventCursor: "0",
          createdAt: Date.now(),
        })
      );

      global.fetch = mockFetch;

      const client = new AgentClient("https://localhost", "test-token");
      const result = await client.createSession();

      expect(mockFetch).toHaveBeenCalledWith(
        "https://localhost/v1/session",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            Authorization: "Bearer test-token",
            "Content-Type": "application/json",
          }),
        })
      );
      expect(result.id).toBe("test-session-id");
      expect(result.workspaceId).toBe("workspace-id");
      expect(result.eventCursor).toBe("0");
    });

    it("should set currentContextId after creating session", async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        createMockResponse({
          id: "new-session-id",
          workspaceId: "workspace-id",
          eventCursor: "0",
          createdAt: Date.now(),
        })
      );

      global.fetch = mockFetch;

      const client = new AgentClient("https://localhost", "test-token");
      await client.createSession();
      
      expect(client.getCurrentContextId()).toBe("new-session-id");
    });

    it("should throw on error response", async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        createMockResponse({ error: "Server error" }, 500)
      );

      global.fetch = mockFetch;

      const client = new AgentClient("https://localhost", "test-token");
      
      await expect(client.createSession()).rejects.toThrow("Server error");
    });
  });

  describe("warmupSession", () => {
    it("should create a throwaway session for warmup", async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        createMockResponse({
          id: "warmup-session-id",
          workspaceId: "workspace-id",
          eventCursor: "0",
          createdAt: Date.now(),
        })
      );

      global.fetch = mockFetch;

      const client = new AgentClient("https://localhost", "test-token");
      await client.warmupSession();

      expect(mockFetch).toHaveBeenCalledWith(
        "https://localhost/v1/session",
        expect.objectContaining({
          method: "POST",
        })
      );
    });

    it("should not throw on success", async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        createMockResponse({
          id: "session-id",
          workspaceId: "workspace-id",
          eventCursor: "0",
          createdAt: Date.now(),
        })
      );

      global.fetch = mockFetch;

      const client = new AgentClient("https://localhost", "test-token");
      
      await expect(client.warmupSession()).resolves.toBeUndefined();
    });
  });
});
