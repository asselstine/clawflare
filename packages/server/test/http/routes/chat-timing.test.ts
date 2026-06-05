import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleChat } from "../../../src/modules/chat/chat.routes.js";
import type { RequestContext } from "../../../src/http/request-context.js";
import type { Env } from "../../../src/internal-types/index.js";

const mocks = vi.hoisted(() => ({
  findByIdInWorkspace: vi.fn(),
  save: vi.fn(),
  markProcessing: vi.fn(),
  createRun: vi.fn(),
  enqueue: vi.fn(),
  latestCursor: vi.fn(),
  resolveModelForNewSession: vi.fn(),
  runSessionRun: vi.fn(),
  seedDefaults: vi.fn(),
}));

vi.mock("../../../src/data/index.js", () => ({
  SessionRepository: vi.fn().mockImplementation(() => ({
    findByIdInWorkspace: mocks.findByIdInWorkspace,
    save: mocks.save,
    markProcessing: mocks.markProcessing,
  })),
  SessionRunRepository: vi.fn().mockImplementation(() => ({
    create: mocks.createRun,
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

vi.mock("../../../src/modules/models/models.service.js", () => ({
  resolveModelForNewSession: mocks.resolveModelForNewSession,
}));

vi.mock("../../../src/runtime/workflow.js", () => ({
  runSessionRun: mocks.runSessionRun,
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
    mocks.resolveModelForNewSession.mockResolvedValue({
      id: "model-1",
      provider: "openai",
      modelName: "gpt-5",
    });
    mocks.createRun.mockResolvedValue(undefined);
    mocks.runSessionRun.mockResolvedValue(undefined);
    mocks.markProcessing.mockResolvedValue(undefined);
    mocks.seedDefaults.mockResolvedValue(undefined);
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
      expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({
        id: "session-1",
        name: "hello",
      }));
      const logs = timingLogs(consoleSpy);
      const phases = logs.map((entry) => entry.phase);

      expect(phases).toEqual(expect.arrayContaining([
        "chat.route.start",
        "chat.request.parsed",
        "chat.session.lookup",
        "chat.auth.context_created",
        "chat.model.resolved",
        "chat.session.created",
        "chat.session_run.created",
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
      expect(mocks.createRun).toHaveBeenCalledWith(expect.objectContaining({
        id: expect.any(String),
        sessionId: "session-1",
        workspaceId: "workspace-1",
        input: expect.objectContaining({
          type: "prompt",
          content: "hello",
          apiReceivedAt: expect.any(Number),
          apiRequestId: expect.any(String),
        }),
      }));
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("creates a session run with initial input for an existing session", async () => {
    mocks.findByIdInWorkspace.mockResolvedValue({
      id: "session-1",
      workspaceId: "workspace-1",
      workflowId: "",
      status: "idle",
      nextEventCursor: "0",
      updatedAt: Date.now(),
      maxQueueSize: 100,
      idleTimeout: "7 days",
      modelId: "model-1",
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
      expect(mocks.createRun).toHaveBeenCalledWith(expect.objectContaining({
        id: expect.any(String),
        sessionId: "session-1",
        workspaceId: "workspace-1",
        input: expect.objectContaining({
          type: "prompt",
          content: "hello",
          apiReceivedAt: expect.any(Number),
          apiRequestId: expect.any(String),
        }),
      }));

      const phases = timingLogs(consoleSpy).map((entry) => entry.phase);
      expect(phases).toEqual(expect.arrayContaining([
        "chat.session.processing_saved",
        "chat.session_run.created",
        "chat.event_cursor.reused",
      ]));
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("creates a fresh session run even when an old run id is stored", async () => {
    mocks.findByIdInWorkspace.mockResolvedValue({
      id: "session-1",
      workspaceId: "workspace-1",
      workflowId: "stale-workflow",
      status: "idle",
      nextEventCursor: "0",
      updatedAt: Date.now(),
      maxQueueSize: 100,
      idleTimeout: "7 days",
      modelId: "model-1",
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
      expect(mocks.markProcessing).toHaveBeenCalledWith("session-1", expect.not.stringMatching(/^stale-workflow$/));
      expect(mocks.createRun).toHaveBeenCalledWith(expect.objectContaining({
        id: expect.not.stringMatching(/^stale-workflow$/),
        sessionId: "session-1",
        workspaceId: "workspace-1",
        input: expect.objectContaining({
          type: "prompt",
          content: "hello",
          apiReceivedAt: expect.any(Number),
          apiRequestId: expect.any(String),
        }),
      }));

      const phases = timingLogs(consoleSpy).map((entry) => entry.phase);
      expect(phases).toContain("chat.session_run.created");
    } finally {
      consoleSpy.mockRestore();
    }
  });
});
