import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleChat } from "../../../src/modules/chat/chat.routes.js";
import type { RequestContext } from "../../../src/http/request-context.js";
import type { Env } from "../../../src/internal-types/index.js";

const mocks = vi.hoisted(() => ({
  findByIdInWorkspace: vi.fn(),
  save: vi.fn(),
  markProcessing: vi.fn(),
  getWorkflowWaitingAt: vi.fn(),
  enqueue: vi.fn(),
  latestCursor: vi.fn(),
  resolveModelConnectionForNewSession: vi.fn(),
  createWorkflowInstance: vi.fn(),
  withWorkflowInstance: vi.fn(),
  seedDefaults: vi.fn(),
}));

vi.mock("../../../src/data/index.js", () => ({
  SessionRepository: vi.fn().mockImplementation(() => ({
    findByIdInWorkspace: mocks.findByIdInWorkspace,
    save: mocks.save,
    markProcessing: mocks.markProcessing,
  })),
  SessionRuntimeRepository: vi.fn().mockImplementation(() => ({
    getWorkflowWaitingAt: mocks.getWorkflowWaitingAt,
  })),
  InputQueueRepository: vi.fn().mockImplementation(() => ({
    enqueue: mocks.enqueue,
  })),
  SessionEventRepository: vi.fn().mockImplementation(() => ({
    latestCursor: mocks.latestCursor,
  })),
  SessionToolRepository: vi.fn().mockImplementation(() => ({
    seedDefaults: mocks.seedDefaults,
  })),
}));

vi.mock("../../../src/modules/model-connections/model-connections.service.js", () => ({
  resolveModelConnectionForNewSession: mocks.resolveModelConnectionForNewSession,
}));

vi.mock("../../../src/runtime/workflow-handles.js", () => ({
  createWorkflowInstance: mocks.createWorkflowInstance,
  withWorkflowInstance: mocks.withWorkflowInstance,
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

describe("handleChat timing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.latestCursor.mockResolvedValue("0");
    mocks.enqueue.mockResolvedValue({ ok: true, queued: 1 });
    mocks.resolveModelConnectionForNewSession.mockResolvedValue({
      id: "model-1",
      provider: "openai",
      modelName: "gpt-5",
    });
    mocks.createWorkflowInstance.mockResolvedValue(undefined);
    mocks.markProcessing.mockResolvedValue(undefined);
    mocks.getWorkflowWaitingAt.mockResolvedValue(Date.now());
    mocks.seedDefaults.mockResolvedValue(undefined);
    mocks.withWorkflowInstance.mockImplementation(async (
      _workflow: unknown,
      _workflowId: string,
      callback: (workflowInstance: { sendEvent: () => Promise<void> }) => Promise<unknown> | unknown,
    ) => {
      await callback({ sendEvent: vi.fn().mockResolvedValue(undefined) });
    });
  });

  it("logs route-level timings for a new chat submission", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const response = await handleChat(
        new Request("https://example.com/v1/chat", {
          method: "POST",
          body: JSON.stringify({ sessionId: "session-1", content: "hello" }),
        }),
        { CLAWFLARE_DEBUG_TIMING: "true" } as Env,
        createRequestContext(),
      );

      expect(response.status).toBe(200);
      const logs = timingLogs(consoleSpy);
      const phases = logs.map((entry) => entry.phase);

      expect(phases).toEqual(expect.arrayContaining([
        "chat.route.start",
        "chat.request.parsed",
        "chat.session.lookup",
        "chat.auth.context_created",
        "chat.model.resolved",
        "chat.session.created",
        "chat.workflow.created",
        "chat.response.serialized",
        "chat.route.response",
      ]));
      expect(logs.find((entry) => entry.phase === "chat.request.parsed")).toMatchObject({
        sessionId: "session-1",
        workspaceId: "workspace-1",
        contentLength: 5,
      });
      expect(logs.find((entry) => entry.phase === "chat.response.serialized")?.responseBytes).toEqual(
        expect.any(Number),
      );
      expect(mocks.createWorkflowInstance).toHaveBeenCalledWith(
        undefined,
        expect.objectContaining({
          id: expect.any(String),
          params: {
            sessionId: "session-1",
            initialInput: expect.objectContaining({
              type: "prompt",
              content: "hello",
              apiReceivedAt: expect.any(Number),
              apiRequestId: expect.any(String),
            }),
          },
        }),
      );
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("creates a workflow with initial input for an existing session without a workflow", async () => {
    mocks.findByIdInWorkspace.mockResolvedValue({
      id: "session-1",
      workspaceId: "workspace-1",
      workflowId: "",
      status: "idle",
      nextEventCursor: "0",
      updatedAt: Date.now(),
      maxQueueSize: 100,
      idleTimeout: "7 days",
      modelConnectionId: "model-1",
      modelProvider: "openai",
      modelName: "gpt-5",
    });

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const response = await handleChat(
        new Request("https://example.com/v1/chat", {
          method: "POST",
          body: JSON.stringify({ sessionId: "session-1", content: "hello" }),
        }),
        { CLAWFLARE_DEBUG_TIMING: "true" } as Env,
        createRequestContext(),
      );

      expect(response.status).toBe(200);
      expect(mocks.markProcessing).toHaveBeenCalledWith("session-1", expect.any(String));
      expect(mocks.createWorkflowInstance).toHaveBeenCalledWith(
        undefined,
        expect.objectContaining({
          id: expect.any(String),
          params: {
            sessionId: "session-1",
            initialInput: expect.objectContaining({
              type: "prompt",
              content: "hello",
              apiReceivedAt: expect.any(Number),
              apiRequestId: expect.any(String),
            }),
          },
        }),
      );
      expect(mocks.withWorkflowInstance).not.toHaveBeenCalled();

      const phases = timingLogs(consoleSpy).map((entry) => entry.phase);
      expect(phases).toEqual(expect.arrayContaining([
        "chat.session.processing_saved",
        "chat.workflow.created",
        "chat.event_cursor.reused",
      ]));
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("recreates with initial input when a stored prewarm workflow is not waiting", async () => {
    mocks.findByIdInWorkspace.mockResolvedValue({
      id: "session-1",
      workspaceId: "workspace-1",
      workflowId: "stale-workflow",
      status: "idle",
      nextEventCursor: "0",
      updatedAt: Date.now(),
      maxQueueSize: 100,
      idleTimeout: "7 days",
      modelConnectionId: "model-1",
      modelProvider: "openai",
      modelName: "gpt-5",
    });
    mocks.getWorkflowWaitingAt.mockResolvedValue(null);

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const response = await handleChat(
        new Request("https://example.com/v1/chat", {
          method: "POST",
          body: JSON.stringify({ sessionId: "session-1", content: "hello" }),
        }),
        { CLAWFLARE_DEBUG_TIMING: "true" } as Env,
        createRequestContext(),
      );

      expect(response.status).toBe(200);
      expect(mocks.markProcessing).toHaveBeenCalledWith("session-1", expect.not.stringMatching(/^stale-workflow$/));
      expect(mocks.createWorkflowInstance).toHaveBeenCalledWith(
        undefined,
        expect.objectContaining({
          id: expect.not.stringMatching(/^stale-workflow$/),
          params: {
            sessionId: "session-1",
            initialInput: expect.objectContaining({
              type: "prompt",
              content: "hello",
              apiReceivedAt: expect.any(Number),
              apiRequestId: expect.any(String),
            }),
          },
        }),
      );
      expect(mocks.withWorkflowInstance).not.toHaveBeenCalled();

      const phases = timingLogs(consoleSpy).map((entry) => entry.phase);
      expect(phases).toContain("chat.workflow.prewarm_not_ready");
    } finally {
      consoleSpy.mockRestore();
    }
  });
});
