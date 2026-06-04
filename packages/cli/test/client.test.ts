import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { AgentClient } from "../src/client.js";

describe("AgentClient", () => {
  // Helper to create a mock fetch response
  function createMockResponse(body: unknown, status = 200): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers({ "content-type": "application/json" }),
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(JSON.stringify(body)),
    } as Response;
  }

  function createSseResponse(events: string[]): Response {
    const encoder = new TextEncoder();
    return {
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "text/event-stream; charset=utf-8" }),
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          for (const event of events) {
            controller.enqueue(encoder.encode(event));
          }
          controller.close();
        },
      }),
      json: () => Promise.reject(new Error("not json")),
      text: () => Promise.resolve(events.join("")),
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

      for await (const update of client.streamSession("session-id", undefined, { initialCursor: "0", transport: "poll" })) {
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

    it("streams session updates over SSE when available", async () => {
      const session = {
        id: "session-id",
        workspaceId: "workspace-id",
        status: "idle",
        messages: [{ role: "assistant", content: "hello" }],
        events: [{
          type: "message_end",
          timestamp: Date.now(),
          sequence: 1,
        }],
        nextEventCursor: "1",
      };
      const mockFetch = vi.fn().mockResolvedValue(
        createSseResponse([`event: session\ndata: ${JSON.stringify(session)}\n\n`])
      );

      global.fetch = mockFetch;

      const client = new AgentClient("https://localhost", "test-token");
      const updates: unknown[] = [];

      for await (const update of client.streamSession("session-id", undefined, { initialCursor: "0", transport: "sse" })) {
        updates.push(update);
      }

      expect(updates).toHaveLength(1);
      expect((updates[0] as { complete: boolean }).complete).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://localhost/v1/session/session-id/events?since=0&includeMessages=auto",
        expect.objectContaining({
          method: "GET",
          headers: expect.objectContaining({
            Authorization: "Bearer test-token",
            Accept: "text/event-stream",
          }),
        })
      );
    });

    it("falls back to polling when SSE is unavailable", async () => {
      const mockFetch = vi.fn()
        .mockResolvedValueOnce(createMockResponse({ error: "Not found" }, 404))
        .mockResolvedValueOnce(createMockResponse({
          id: "session-id",
          workspaceId: "workspace-id",
          status: "idle",
          messages: [],
          events: [{
            type: "message_end",
            timestamp: Date.now(),
            sequence: 1,
          }],
          nextEventCursor: "1",
        }));

      global.fetch = mockFetch;

      const client = new AgentClient("https://localhost", "test-token");
      const updates: unknown[] = [];

      for await (const update of client.streamSession("session-id", undefined, { initialCursor: "0" })) {
        updates.push(update);
      }

      expect(updates).toHaveLength(1);
      expect(mockFetch).toHaveBeenNthCalledWith(
        1,
        "https://localhost/v1/session/session-id/events?since=0&includeMessages=auto",
        expect.any(Object)
      );
      expect(mockFetch).toHaveBeenNthCalledWith(
        2,
        "https://localhost/v1/session/session-id?since=0&includeMessages=auto",
        expect.any(Object)
      );
    });

    it("resumes with polling when a WebSocket disconnects after streaming", async () => {
      const processingSession = {
        id: "session-id",
        workspaceId: "workspace-id",
        status: "processing",
        messages: [],
        events: [{
          type: "message_start",
          timestamp: Date.now(),
          sequence: 1,
        }],
        nextEventCursor: "1",
      };
      const completedSession = {
        id: "session-id",
        workspaceId: "workspace-id",
        status: "idle",
        messages: [{ role: "assistant", content: "done" }],
        events: [{
          type: "message_end",
          timestamp: Date.now(),
          sequence: 2,
        }],
        nextEventCursor: "2",
      };
      const mockFetch = vi.fn().mockResolvedValue(createMockResponse(completedSession));

      global.fetch = mockFetch;

      const ws = new EventEmitter() as EventEmitter & {
        readyState: number;
        close: ReturnType<typeof vi.fn>;
      };
      ws.readyState = 1;
      ws.close = vi.fn(() => {
        ws.readyState = 3;
      });

      const client = new AgentClient("https://localhost", "test-token");
      vi.spyOn(client as never, "openWebSocket").mockImplementation(async () => {
        setTimeout(() => {
          ws.emit("message", JSON.stringify({ type: "session", session: processingSession }));
          ws.emit("error", new Error("Network connection lost"));
        }, 0);
        return ws;
      });

      const updates: unknown[] = [];

      for await (const update of client.streamSession("session-id", undefined, {
        initialCursor: "0",
        pollIntervalMs: 1,
        transport: "ws",
      })) {
        updates.push(update);
      }

      expect(updates).toHaveLength(2);
      expect((updates[0] as { complete: boolean }).complete).toBe(false);
      expect((updates[1] as { complete: boolean }).complete).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://localhost/v1/session/session-id?since=1&includeMessages=auto",
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
