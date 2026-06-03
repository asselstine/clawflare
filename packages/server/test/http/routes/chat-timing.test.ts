import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleChat } from "../../../src/modules/chat/chat.routes.js";
import type { RequestContext } from "../../../src/http/request-context.js";
import type { Env } from "../../../src/internal-types/index.js";

const mocks = vi.hoisted(() => ({
  findByIdInWorkspace: vi.fn(),
  save: vi.fn(),
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
        "chat.input.enqueued",
        "chat.workflow.created",
        "chat.workflow.woke",
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
    } finally {
      consoleSpy.mockRestore();
    }
  });
});
