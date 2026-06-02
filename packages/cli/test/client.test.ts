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

  describe("streamSession", () => {
    it("keeps polling a completed session when the event page is full", async () => {
      const fullPageEvents = Array.from({ length: 100 }, (_, index) => ({
        type: "message",
        timestamp: Date.now(),
        sequence: index + 1,
      }));
      const mockFetch = vi.fn()
        .mockResolvedValueOnce(createMockResponse({
          id: "session-id",
          workspaceId: "workspace-id",
          status: "idle",
          messages: [],
          events: fullPageEvents,
          nextEventCursor: "100",
        }))
        .mockResolvedValueOnce(createMockResponse({
          id: "session-id",
          workspaceId: "workspace-id",
          status: "idle",
          messages: [],
          events: [{
            type: "message",
            timestamp: Date.now(),
            sequence: 101,
          }],
          nextEventCursor: "101",
        }));

      global.fetch = mockFetch;

      const client = new AgentClient("https://localhost", "test-token");
      const updates: unknown[] = [];

      for await (const update of client.streamSession("session-id", undefined, { initialCursor: "0" })) {
        updates.push(update);
      }

      expect(updates).toHaveLength(2);
      expect(updates.map((update) => (update as { complete: boolean }).complete)).toEqual([false, true]);
      expect(mockFetch).toHaveBeenNthCalledWith(
        1,
        "https://localhost/v1/session/session-id?since=0&includeMessages=auto",
        expect.any(Object)
      );
      expect(mockFetch).toHaveBeenNthCalledWith(
        2,
        "https://localhost/v1/session/session-id?since=100&includeMessages=auto",
        expect.any(Object)
      );
    });
  });

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

  describe("killSession", () => {
    it("should kill a session via POST /v1/session/:id/kill", async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        createMockResponse({
          ok: true,
          sessionId: "session-id",
          workspaceId: "workspace-id",
          status: "closed",
          workflowId: "workflow-id",
          workflowStatusBefore: "running",
          workflowTerminated: true,
          destroyedContainers: ["container-id"],
          errors: [],
        })
      );

      global.fetch = mockFetch;

      const client = new AgentClient("https://localhost", "test-token");
      const result = await client.killSession("session-id");

      expect(mockFetch).toHaveBeenCalledWith(
        "https://localhost/v1/session/session-id/kill",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            Authorization: "Bearer test-token",
            "Content-Type": "application/json",
          }),
        })
      );
      expect(result.workflowTerminated).toBe(true);
      expect(result.destroyedContainers).toEqual(["container-id"]);
    });
  });
});
