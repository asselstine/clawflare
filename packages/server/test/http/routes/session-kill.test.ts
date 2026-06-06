import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleAbortSession, handleDeleteSession, handleDeleteSessions, handleKillSession } from "../../../src/modules/sessions/sessions.routes.js";
import type { RequestContext } from "../../../src/http/request-context.js";
import type { Env } from "../../../src/internal-types/index.js";

const mocks = vi.hoisted(() => ({
  findByIdInWorkspace: vi.fn(),
  listSessions: vi.fn(),
  saveSession: vi.fn(),
  markClosed: vi.fn(),
  deleteSession: vi.fn(),
  append: vi.fn(),
  setActive: vi.fn(),
  findActiveForSession: vi.fn(),
  requestCancelRun: vi.fn(),
  cancelRun: vi.fn(),
  getWorkflowSession: vi.fn(),
  saveWorkflowSession: vi.fn(),
  listForSession: vi.fn(),
  unlinkSession: vi.fn(),
  listLinksForContainer: vi.fn(),
  markDestroyed: vi.fn(),
  destroyContainer: vi.fn(),
  containerBashCancel: vi.fn(),
  projectAndAppendAgentEvents: vi.fn(),
}));

vi.mock("../../../src/data/index.js", () => ({
  SessionRepository: vi.fn().mockImplementation(() => ({
    findByIdInWorkspace: mocks.findByIdInWorkspace,
    list: mocks.listSessions,
    save: mocks.saveSession,
    markClosed: mocks.markClosed,
    delete: mocks.deleteSession,
  })),
  SessionEventRepository: vi.fn().mockImplementation(() => ({
    append: mocks.append,
  })),
  SessionMessageRepository: vi.fn().mockImplementation(() => ({})),
  SessionRuntimeRepository: vi.fn().mockImplementation(() => ({
    setActive: mocks.setActive,
    getWorkflowSession: mocks.getWorkflowSession,
    saveWorkflowSession: mocks.saveWorkflowSession,
  })),
  SessionRunRepository: vi.fn().mockImplementation(() => ({
    findActiveForSession: mocks.findActiveForSession,
    requestCancel: mocks.requestCancelRun,
    cancel: mocks.cancelRun,
  })),
  ContainerRepository: vi.fn().mockImplementation(() => ({
    listForSession: mocks.listForSession,
    unlinkSession: mocks.unlinkSession,
    listLinksForContainer: mocks.listLinksForContainer,
    markDestroyed: mocks.markDestroyed,
  })),
  InputQueueRepository: vi.fn(),
}));

vi.mock("../../../src/modules/tools/container/client.js", () => ({
  destroyContainer: mocks.destroyContainer,
  containerBashCancel: mocks.containerBashCancel,
}));

vi.mock("../../../src/runtime/message-projection.js", () => ({
  projectAndAppendAgentEvents: mocks.projectAndAppendAgentEvents,
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

describe("handleAbortSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getWorkflowSession.mockResolvedValue(null);
    mocks.saveWorkflowSession.mockResolvedValue({ written: false, skippedUnchanged: true, serializedJson: "{}", serializedBytes: 2 });
    mocks.projectAndAppendAgentEvents.mockResolvedValue(undefined);
  });

  it("cancels a running run immediately and marks the session idle", async () => {
    const now = Date.now();
    mocks.findByIdInWorkspace.mockResolvedValue({
      id: "session-1",
      workspaceId: "workspace-1",
      workflowId: "run-1",
      status: "processing",
      nextEventCursor: "0",
      updatedAt: now,
      maxQueueSize: 100,
    });
    mocks.findActiveForSession.mockResolvedValue({
      id: "run-1",
      sessionId: "session-1",
      workspaceId: "workspace-1",
      status: "running",
    });
    mocks.cancelRun.mockResolvedValue(undefined);
    mocks.saveSession.mockResolvedValue(undefined);
    mocks.setActive.mockResolvedValue(undefined);

    const response = await handleAbortSession("session-1", {} as Env, createRequestContext());
    const data = (await response.json()) as {
      ok: boolean;
      status: string;
      aborted: boolean;
    };

    expect(response.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.status).toBe("idle");
    expect(data.aborted).toBe(true);
    expect(mocks.requestCancelRun).not.toHaveBeenCalled();
    expect(mocks.cancelRun).toHaveBeenCalledWith("run-1");
    expect(mocks.saveSession).toHaveBeenCalledWith(expect.objectContaining({
      id: "session-1",
      status: "idle",
      errorMessage: undefined,
    }));
    expect(mocks.markClosed).not.toHaveBeenCalled();
    expect(mocks.setActive).toHaveBeenCalledWith("session-1", false);
  });

  it("cancels running container bash tool calls and leaves the session usable", async () => {
    const now = Date.now();
    mocks.findByIdInWorkspace.mockResolvedValue({
      id: "session-1",
      workspaceId: "workspace-1",
      workflowId: "run-1",
      status: "processing",
      nextEventCursor: "0",
      updatedAt: now,
      maxQueueSize: 100,
    });
    mocks.findActiveForSession.mockResolvedValue({
      id: "run-1",
      sessionId: "session-1",
      workspaceId: "workspace-1",
      status: "running",
    });
    mocks.getWorkflowSession.mockResolvedValue({
      id: "session-1",
      createdAt: now,
      updatedAt: now,
      systemPrompt: "",
      model: {},
      thinkingLevel: "none",
      messages: [],
      steeringQueue: [],
      followUpQueue: [],
      steeringMode: "all",
      followUpMode: "all",
      turns: [{
        id: "turn-1",
        index: 0,
        status: "awaiting_tools",
        toolCallIds: ["tool-1"],
        toolResultIds: [],
      }],
      toolCalls: {
        "tool-1": {
          id: "tool-1",
          name: "container_bash",
          args: {},
          turnId: "turn-1",
          status: "running",
          asyncState: {
            kind: "container_bash",
            containerId: "container-1",
            commandId: "command-1",
          },
        },
      },
      status: "running",
    });
    mocks.cancelRun.mockResolvedValue(undefined);
    mocks.containerBashCancel.mockResolvedValue({ ok: true });
    mocks.saveSession.mockResolvedValue(undefined);
    mocks.setActive.mockResolvedValue(undefined);

    const response = await handleAbortSession("session-1", {} as Env, createRequestContext());
    const data = (await response.json()) as {
      ok: boolean;
      status: string;
      stoppedToolCallIds: string[];
    };

    expect(response.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.status).toBe("idle");
    expect(data.stoppedToolCallIds).toEqual(["tool-1"]);
    expect(mocks.containerBashCancel).toHaveBeenCalledWith({} as Env, "container-1", "command-1");
    expect(mocks.saveWorkflowSession).toHaveBeenCalledWith("session-1", expect.objectContaining({
      status: "idle",
      toolCalls: expect.objectContaining({
        "tool-1": expect.objectContaining({
          status: "error",
          isError: true,
          asyncState: undefined,
        }),
      }),
    }));
    expect(mocks.projectAndAppendAgentEvents).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "session-1",
      [expect.objectContaining({
        type: "tool_execution_end",
        toolCallId: "tool-1",
        toolName: "container_bash",
        isError: true,
      })],
      { workspaceId: "workspace-1" },
    );
    expect(mocks.setActive).toHaveBeenCalledWith("session-1", false);
  });

  it("returns ok when there is no active run to cancel", async () => {
    mocks.findByIdInWorkspace.mockResolvedValue({
      id: "session-1",
      workspaceId: "workspace-1",
      workflowId: "run-1",
      status: "idle",
      nextEventCursor: "0",
      updatedAt: Date.now(),
      maxQueueSize: 100,
    });
    mocks.findActiveForSession.mockResolvedValue(null);

    const response = await handleAbortSession("session-1", {} as Env, createRequestContext());
    const data = (await response.json()) as {
      ok: boolean;
      status: string;
      aborted: boolean;
    };

    expect(response.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.status).toBe("idle");
    expect(data.aborted).toBe(false);
    expect(mocks.requestCancelRun).not.toHaveBeenCalled();
    expect(mocks.markClosed).not.toHaveBeenCalled();
  });

  it("cancels a runnable run immediately and marks the session idle", async () => {
    const now = Date.now();
    mocks.findByIdInWorkspace.mockResolvedValue({
      id: "session-1",
      workspaceId: "workspace-1",
      workflowId: "run-1",
      status: "processing",
      nextEventCursor: "0",
      updatedAt: now,
      maxQueueSize: 100,
    });
    mocks.findActiveForSession.mockResolvedValue({
      id: "run-1",
      sessionId: "session-1",
      workspaceId: "workspace-1",
      status: "runnable",
    });
    mocks.cancelRun.mockResolvedValue(undefined);
    mocks.saveSession.mockResolvedValue(undefined);
    mocks.setActive.mockResolvedValue(undefined);

    const response = await handleAbortSession("session-1", {} as Env, createRequestContext());
    const data = (await response.json()) as {
      ok: boolean;
      status: string;
      aborted: boolean;
    };

    expect(response.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.status).toBe("idle");
    expect(data.aborted).toBe(true);
    expect(mocks.requestCancelRun).not.toHaveBeenCalled();
    expect(mocks.cancelRun).toHaveBeenCalledWith("run-1");
    expect(mocks.saveSession).toHaveBeenCalledWith(expect.objectContaining({
      id: "session-1",
      status: "idle",
      errorMessage: undefined,
    }));
    expect(mocks.setActive).toHaveBeenCalledWith("session-1", false);
    expect(mocks.markClosed).not.toHaveBeenCalled();
  });
});

describe("handleKillSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("cancels the active run, destroys session containers, and closes the session", async () => {
    mocks.findByIdInWorkspace.mockResolvedValue({
      id: "session-1",
      workspaceId: "workspace-1",
      workflowId: "run-1",
      status: "processing",
      nextEventCursor: "0",
      updatedAt: Date.now(),
      maxQueueSize: 100,
    });
    mocks.listForSession.mockResolvedValue([
      {
        id: "container-1",
        workspaceId: "workspace-1",
        status: "active",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ]);
    mocks.listLinksForContainer.mockResolvedValue([{ sessionId: "session-1", containerId: "container-1" }]);
    mocks.destroyContainer.mockResolvedValue(undefined);
    mocks.unlinkSession.mockResolvedValue(undefined);
    mocks.markDestroyed.mockResolvedValue(undefined);
    mocks.append.mockResolvedValue({ nextCursor: "1" });
    mocks.markClosed.mockResolvedValue(undefined);
    mocks.setActive.mockResolvedValue(undefined);
    mocks.findActiveForSession.mockResolvedValue({
      id: "run-1",
      sessionId: "session-1",
      workspaceId: "workspace-1",
      status: "running",
    });
    mocks.cancelRun.mockResolvedValue(undefined);

    const env = {} as Env;

    const response = await handleKillSession("session-1", env, createRequestContext());
    const data = (await response.json()) as {
      ok: boolean;
      status: string;
      workflowTerminated: boolean;
      destroyedContainers: string[];
    };

    expect(response.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.status).toBe("closed");
    expect(data.workflowTerminated).toBe(true);
    expect(data.destroyedContainers).toEqual(["container-1"]);
    expect(mocks.cancelRun).toHaveBeenCalledWith("run-1");
    expect(mocks.destroyContainer).toHaveBeenCalledWith(env, "container-1");
    expect(mocks.unlinkSession).not.toHaveBeenCalled();
    expect(mocks.markDestroyed).toHaveBeenCalledWith("workspace-1", "container-1");
    expect(mocks.markClosed).toHaveBeenCalledWith("session-1", "user");
    expect(mocks.setActive).toHaveBeenCalledWith("session-1", false);
  });
});

describe("handleDeleteSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("kills an active session before deleting it", async () => {
    mocks.findByIdInWorkspace.mockResolvedValue({
      id: "session-1",
      workspaceId: "workspace-1",
      workflowId: "run-1",
      status: "processing",
      nextEventCursor: "0",
      updatedAt: Date.now(),
      maxQueueSize: 100,
    });
    mocks.findActiveForSession.mockResolvedValue({
      id: "run-1",
      sessionId: "session-1",
      workspaceId: "workspace-1",
      status: "running",
    });
    mocks.listForSession.mockResolvedValue([{ id: "container-1" }]);
    mocks.listLinksForContainer.mockResolvedValue([{ sessionId: "session-1", containerId: "container-1" }]);
    mocks.destroyContainer.mockResolvedValue(undefined);
    mocks.unlinkSession.mockResolvedValue(undefined);
    mocks.markDestroyed.mockResolvedValue(undefined);
    mocks.append.mockResolvedValue({ nextCursor: "1" });
    mocks.markClosed.mockResolvedValue(undefined);
    mocks.setActive.mockResolvedValue(undefined);
    mocks.deleteSession.mockResolvedValue(true);

    const env = {} as Env;
    const response = await handleDeleteSession("session-1", env, createRequestContext());
    const data = (await response.json()) as {
      ok: boolean;
      deleted: boolean;
      killedBeforeDelete: boolean;
      workflowTerminated: boolean;
      destroyedContainers: string[];
    };

    expect(response.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.deleted).toBe(true);
    expect(data.killedBeforeDelete).toBe(true);
    expect(data.workflowTerminated).toBe(true);
    expect(data.destroyedContainers).toEqual(["container-1"]);
    expect(mocks.cancelRun).toHaveBeenCalledWith("run-1");
    expect(mocks.append).toHaveBeenCalled();
    expect(mocks.markClosed).toHaveBeenCalledWith("session-1", "user");
    expect(mocks.deleteSession).toHaveBeenCalledWith("session-1", "workspace-1");
  });

  it("deletes an already closed session without recording another kill event", async () => {
    mocks.findByIdInWorkspace.mockResolvedValue({
      id: "session-1",
      workspaceId: "workspace-1",
      workflowId: "",
      status: "closed",
      nextEventCursor: "0",
      updatedAt: Date.now(),
      maxQueueSize: 100,
    });
    mocks.findActiveForSession.mockResolvedValue(null);
    mocks.listForSession.mockResolvedValue([]);
    mocks.markClosed.mockResolvedValue(undefined);
    mocks.setActive.mockResolvedValue(undefined);
    mocks.deleteSession.mockResolvedValue(true);

    const response = await handleDeleteSession("session-1", {} as Env, createRequestContext());
    const data = (await response.json()) as { deleted: boolean; killedBeforeDelete: boolean };

    expect(response.status).toBe(200);
    expect(data.deleted).toBe(true);
    expect(data.killedBeforeDelete).toBe(false);
    expect(mocks.append).not.toHaveBeenCalled();
    expect(mocks.deleteSession).toHaveBeenCalledWith("session-1", "workspace-1");
  });
});

describe("handleDeleteSessions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("deletes all workspace sessions with one collection handler call", async () => {
    mocks.listSessions.mockResolvedValueOnce([
      { id: "session-1", status: "processing" },
      { id: "session-2", status: "closed" },
    ]).mockResolvedValueOnce([]);
    mocks.findByIdInWorkspace
      .mockResolvedValueOnce({
        id: "session-1",
        workspaceId: "workspace-1",
        workflowId: "run-1",
        status: "processing",
        nextEventCursor: "0",
        updatedAt: Date.now(),
        maxQueueSize: 100,
      })
      .mockResolvedValueOnce({
        id: "session-2",
        workspaceId: "workspace-1",
        workflowId: "",
        status: "closed",
        nextEventCursor: "0",
        updatedAt: Date.now(),
        maxQueueSize: 100,
      });
    mocks.findActiveForSession.mockResolvedValue(null);
    mocks.listForSession.mockResolvedValue([]);
    mocks.append.mockResolvedValue({ nextCursor: "1" });
    mocks.markClosed.mockResolvedValue(undefined);
    mocks.setActive.mockResolvedValue(undefined);
    mocks.deleteSession.mockResolvedValue(true);

    const response = await handleDeleteSessions({} as Env, createRequestContext());
    const data = (await response.json()) as { ok: boolean; deleted: number; total: number };

    expect(response.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.deleted).toBe(2);
    expect(data.total).toBe(2);
    expect(mocks.listSessions).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      status: "all",
      limit: 100,
      offset: 0,
    });
    expect(mocks.deleteSession).toHaveBeenCalledWith("session-1", "workspace-1");
    expect(mocks.deleteSession).toHaveBeenCalledWith("session-2", "workspace-1");
  });
});
