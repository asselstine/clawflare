import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleGetSession, handleStreamSessionEvents } from "../../../src/modules/sessions/sessions.routes.js";
import type { RequestContext } from "../../../src/http/request-context.js";
import type { Env } from "../../../src/internal-types/index.js";

const mocks = vi.hoisted(() => ({
  findByIdInWorkspace: vi.fn(),
  save: vi.fn(),
  listSince: vi.fn(),
  listRecent: vi.fn(),
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
  })),
  SessionRuntimeRepository: vi.fn().mockImplementation(() => ({
    getWorkflowSession: mocks.getWorkflowSession,
  })),
  ContainerContextRepository: vi.fn(),
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
    mocks.getWorkflowSession.mockResolvedValue({ messages: [] });

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

  it("can skip loading full messages for incremental polls without message events", async () => {
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

    const data = (await response.json()) as { messages?: unknown[]; events: unknown[] };

    expect(response.status).toBe(200);
    expect(data.messages).toBeUndefined();
    expect(data.events).toHaveLength(1);
    expect(mocks.getWorkflowSession).not.toHaveBeenCalled();
  });

  it("can load the recent event tail without loading full messages", async () => {
    mocks.findByIdInWorkspace.mockResolvedValue({
      id: "session-1",
      workspaceId: "workspace-1",
      workflowId: "workflow-1",
      status: "idle",
      nextEventCursor: "42",
      updatedAt: Date.now(),
      maxQueueSize: 100,
    });
    mocks.listRecent.mockResolvedValue([
      {
        type: "message_end",
        timestamp: Date.now(),
        sequence: 41,
        message: { role: "user", content: "hello" },
      },
      {
        type: "message_end",
        timestamp: Date.now(),
        sequence: 42,
        message: { role: "assistant", content: "hi" },
      },
    ]);

    const response = await handleGetSession(
      "session-1",
      new URL("https://example.com/v1/session/session-1?includeMessages=0&eventWindow=tail&eventLimit=100"),
      {} as Env,
      createRequestContext(),
    );

    const data = (await response.json()) as { messages?: unknown[]; events: unknown[]; nextEventCursor: string };

    expect(response.status).toBe(200);
    expect(data.messages).toBeUndefined();
    expect(data.events).toHaveLength(2);
    expect(data.nextEventCursor).toBe("42");
    expect(mocks.listRecent).toHaveBeenCalledWith("session-1", 100);
    expect(mocks.listSince).not.toHaveBeenCalled();
    expect(mocks.getWorkflowSession).not.toHaveBeenCalled();
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
    expect(mocks.getWorkflowSession).not.toHaveBeenCalled();
  });

  it("logs poll timings and response size without loading skipped messages", async () => {
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
        "session.poll.messages_decided",
        "session.poll.response_serialized",
        "session.poll.response",
      ]));
      expect(phases).not.toContain("session.poll.messages_loaded");
      expect(logs.find((entry) => entry.phase === "session.poll.events_loaded")).toMatchObject({
        sessionId: "session-1",
        workspaceId: "workspace-1",
        eventCount: 1,
        nextCursor: "2",
      });
      expect(logs.find((entry) => entry.phase === "session.poll.response_serialized")?.responseBytes).toEqual(
        expect.any(Number),
      );
      expect(mocks.getWorkflowSession).not.toHaveBeenCalled();
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
      events: [{ type: "message_end", timestamp: Date.now(), sequence: 1 }],
      nextCursor: "1",
    });
    mocks.getWorkflowSession.mockResolvedValue({
      messages: [{ role: "assistant", content: "hello" }],
    });

    const response = await handleStreamSessionEvents(
      "session-1",
      new URL("https://example.com/v1/session/session-1/events?since=0&includeMessages=auto"),
      new Request("https://example.com/v1/session/session-1/events"),
      {} as Env,
      createRequestContext(),
    );
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(body).toContain("event: session");
    expect(body).toContain("\"status\":\"idle\"");
    expect(body).toContain("\"content\":\"hello\"");
  });
});
