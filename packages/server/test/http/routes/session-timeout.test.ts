import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleGetSession, handleStreamSessionEvents } from "../../../src/modules/sessions/sessions.routes.js";
import type { RequestContext } from "../../../src/http/request-context.js";
import type { Env } from "../../../src/internal-types/index.js";

const mocks = vi.hoisted(() => ({
  findByIdInWorkspace: vi.fn(),
  save: vi.fn(),
  listSince: vi.fn(),
  listRecent: vi.fn(),
  listBefore: vi.fn(),
  listMessages: vi.fn(),
  getWorkflowSession: vi.fn(),
}));

vi.mock("../../../src/data/index.js", () => ({
  SessionRepository: vi.fn().mockImplementation(() => ({
    findByIdInWorkspace: mocks.findByIdInWorkspace,
    save: mocks.save,
  })),
  SessionEventRepository: vi.fn().mockImplementation(() => ({
    listSince: mocks.listSince,
    listRecent: mocks.listRecent,
    listBefore: mocks.listBefore,
  })),
  SessionRuntimeRepository: vi.fn().mockImplementation(() => ({
    getWorkflowSession: mocks.getWorkflowSession,
  })),
  SessionMessageRepository: vi.fn().mockImplementation(() => ({
    list: mocks.listMessages,
  })),
  ContainerRepository: vi.fn(),
  InputQueueRepository: vi.fn(),
}));

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
  };
}

function timingLogs(consoleSpy: ReturnType<typeof vi.spyOn>) {
  return consoleSpy.mock.calls
    .map((call) => JSON.parse(call[0] as string))
    .filter((entry) => entry.source === "clawflare-timing");
}

describe("handleGetSession timeout recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listMessages.mockResolvedValue({ messages: [], nextCursor: "0" });
  });

  it("returns the recovered error status in the same poll response", async () => {
    mocks.findByIdInWorkspace.mockResolvedValue({
      id: "session-1",
      workspaceId: "workspace-1",
      workflowId: "workflow-1",
      status: "processing",
      nextEventCursor: "0",
      updatedAt: Date.now() - 31 * 60 * 1000,
      maxQueueSize: 100,
    });
    mocks.save.mockResolvedValue(undefined);
    mocks.listSince.mockResolvedValue({ events: [], nextCursor: "0" });

    const response = await handleGetSession(
      "session-1",
      new URL("https://example.com/v1/session/session-1"),
      {} as Env,
      createRequestContext(),
    );

    const data = (await response.json()) as { status: string; errorMessage?: string };

    expect(response.status).toBe(200);
    expect(data.status).toBe("error");
    expect(data.errorMessage).toContain("Session timed out");
    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ status: "error" }));
  });

  it("returns durable messages for incremental polls without message events", async () => {
    mocks.findByIdInWorkspace.mockResolvedValue({
      id: "session-1",
      workspaceId: "workspace-1",
      workflowId: "workflow-1",
      status: "processing",
      nextEventCursor: "1",
      updatedAt: Date.now(),
      maxQueueSize: 100,
    });
    mocks.listSince.mockResolvedValue({
      events: [{ type: "tool_execution_update", timestamp: Date.now(), sequence: 2 }],
      nextCursor: "2",
    });

    const response = await handleGetSession(
      "session-1",
      new URL("https://example.com/v1/session/session-1?since=1&includeMessages=auto"),
      {} as Env,
      createRequestContext(),
    );

    const data = (await response.json()) as { messages: unknown[]; events: unknown[] };

    expect(response.status).toBe(200);
    expect(data.messages).toEqual([]);
    expect(data.events).toHaveLength(1);
    expect(mocks.listMessages).toHaveBeenCalled();
  });

  it("loads canonical event deltas and durable messages together", async () => {
    mocks.findByIdInWorkspace.mockResolvedValue({
      id: "session-1",
      workspaceId: "workspace-1",
      workflowId: "workflow-1",
      status: "idle",
      nextEventCursor: "42",
      updatedAt: Date.now(),
      maxQueueSize: 100,
    });
    mocks.listSince.mockResolvedValue({
      nextCursor: "42",
      events: [
      {
        type: "message.completed",
        timestamp: Date.now(),
        sequence: 41,
        message: { id: "user-1", sessionId: "session-1", sequence: 1, role: "user", status: "complete", content: [{ type: "text", text: "hello" }], createdAt: 1, updatedAt: 1 },
      },
      {
        type: "message.completed",
        timestamp: Date.now(),
        sequence: 42,
        message: { id: "assistant-1", sessionId: "session-1", sequence: 2, role: "assistant", status: "complete", content: [{ type: "text", text: "hi" }], createdAt: 2, updatedAt: 2 },
      },
    ]});
    mocks.listMessages.mockResolvedValue({
      nextCursor: "2",
      messages: [
        { id: "user-1", sessionId: "session-1", sequence: 1, role: "user", status: "complete", content: [{ type: "text", text: "hello" }], createdAt: 1, updatedAt: 1 },
        { id: "assistant-1", sessionId: "session-1", sequence: 2, role: "assistant", status: "complete", content: [{ type: "text", text: "hi" }], createdAt: 2, updatedAt: 2 },
      ],
    });

    const response = await handleGetSession(
      "session-1",
      new URL("https://example.com/v1/session/session-1?since=40&eventLimit=100"),
      {} as Env,
      createRequestContext(),
    );

    const data = (await response.json()) as { messages: unknown[]; events: unknown[]; nextEventCursor: string };

    expect(response.status).toBe(200);
    expect(data.messages).toHaveLength(2);
    expect(data.events).toHaveLength(2);
    expect(data.nextEventCursor).toBe("42");
    expect(mocks.listSince).toHaveBeenCalledWith("session-1", "40", 100);
  });

  it("passes message pagination cursors to the message repository", async () => {
    mocks.findByIdInWorkspace.mockResolvedValue({
      id: "session-1",
      workspaceId: "workspace-1",
      workflowId: "workflow-1",
      status: "idle",
      nextEventCursor: "42",
      updatedAt: Date.now(),
      maxQueueSize: 100,
    });
    mocks.listSince.mockResolvedValue({ events: [], nextCursor: "42" });

    const response = await handleGetSession(
      "session-1",
      new URL("https://example.com/v1/session/session-1?beforeMessage=41&eventLimit=100"),
      {} as Env,
      createRequestContext(),
    );

    const data = (await response.json()) as { messages: unknown[]; events: unknown[]; nextEventCursor: string };

    expect(response.status).toBe(200);
    expect(data.messages).toEqual([]);
    expect(data.events).toHaveLength(0);
    expect(data.nextEventCursor).toBe("42");
    expect(mocks.listMessages).toHaveBeenCalledWith("session-1", expect.objectContaining({ before: "41" }));
  });

  it("includes runtime prompt history when requested", async () => {
    mocks.findByIdInWorkspace.mockResolvedValue({
      id: "session-1",
      workspaceId: "workspace-1",
      workflowId: "workflow-1",
      status: "idle",
      nextEventCursor: "1",
      updatedAt: Date.now(),
      maxQueueSize: 100,
    });
    mocks.listSince.mockResolvedValue({ events: [], nextCursor: "1" });
    mocks.getWorkflowSession.mockResolvedValue({
      id: "session-1",
      systemPrompt: "You are Clawflare.",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    });

    const response = await handleGetSession(
      "session-1",
      new URL("https://example.com/v1/session/session-1?includePromptHistory=1"),
      {} as Env,
      createRequestContext(),
    );

    const data = (await response.json()) as {
      promptHistory?: { systemPrompt: string; messages: unknown[] };
    };

    expect(response.status).toBe(200);
    expect(data.promptHistory).toEqual({
      systemPrompt: "You are Clawflare.",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    });
  });

  it("does not return stale error messages for idle sessions", async () => {
    mocks.findByIdInWorkspace.mockResolvedValue({
      id: "session-1",
      workspaceId: "workspace-1",
      workflowId: "workflow-1",
      status: "idle",
      nextEventCursor: "0",
      updatedAt: Date.now(),
      errorMessage: '"undefined" is not valid JSON',
      maxQueueSize: 100,
    });
    mocks.listSince.mockResolvedValue({ events: [], nextCursor: "0" });

    const response = await handleGetSession(
      "session-1",
      new URL("https://example.com/v1/session/session-1?includeMessages=0"),
      {} as Env,
      createRequestContext(),
    );

    const data = (await response.json()) as { status: string; errorMessage?: string };

    expect(response.status).toBe(200);
    expect(data.status).toBe("idle");
    expect(data.errorMessage).toBeUndefined();
  });

  it("logs poll timings and response size with durable messages", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      mocks.findByIdInWorkspace.mockResolvedValue({
        id: "session-1",
        workspaceId: "workspace-1",
        workflowId: "workflow-1",
        status: "processing",
        nextEventCursor: "1",
        updatedAt: Date.now(),
        maxQueueSize: 100,
      });
      mocks.listSince.mockResolvedValue({
        events: [{ type: "tool_execution_update", timestamp: Date.now(), sequence: 2 }],
        nextCursor: "2",
      });

      const response = await handleGetSession(
        "session-1",
        new URL("https://example.com/v1/session/session-1?since=1&includeMessages=auto"),
        { CLAWFLARE_DEBUG_TIMING: "true" } as Env,
        createRequestContext(),
      );

      expect(response.status).toBe(200);
      const logs = timingLogs(consoleSpy);
      const phases = logs.map((entry) => entry.phase);

      expect(phases).toEqual(expect.arrayContaining([
        "session.poll.start",
        "session.poll.lookup",
        "session.poll.events_loaded",
        "session.poll.messages_loaded",
        "session.poll.response_serialized",
        "session.poll.response",
      ]));
      expect(logs.find((entry) => entry.phase === "session.poll.events_loaded")).toMatchObject({
        sessionId: "session-1",
        workspaceId: "workspace-1",
        eventCount: 1,
        nextCursor: "2",
      });
      expect(logs.find((entry) => entry.phase === "session.poll.response_serialized")?.responseBytes).toEqual(
        expect.any(Number),
      );
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("streams session responses as server-sent events", async () => {
    mocks.findByIdInWorkspace.mockResolvedValue({
      id: "session-1",
      workspaceId: "workspace-1",
      workflowId: "workflow-1",
      status: "idle",
      nextEventCursor: "1",
      updatedAt: Date.now(),
      maxQueueSize: 100,
    });
    mocks.listSince.mockResolvedValue({
      events: [{ type: "message.completed", timestamp: Date.now(), sequence: 1 }],
      nextCursor: "1",
    });
    mocks.listMessages.mockResolvedValue({
      nextCursor: "1",
      messages: [{ id: "assistant-1", sessionId: "session-1", sequence: 1, role: "assistant", status: "complete", content: [{ type: "text", text: "hello" }], createdAt: 1, updatedAt: 1 }],
    });

    const response = await handleStreamSessionEvents(
      "session-1",
      new URL("https://example.com/v1/session/session-1/events?since=0"),
      new Request("https://example.com/v1/session/session-1/events"),
      {} as Env,
      createRequestContext(),
    );
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(body).toContain("event: session");
    expect(body).toContain("\"status\":\"idle\"");
    expect(body).toContain("hello");
  });
});
