import { describe, expect, it, vi } from "vitest";
import { handleKillSession } from "../../../src/modules/sessions/sessions.routes.js";
import type { RequestContext } from "../../../src/http/request-context.js";
import type { Env } from "../../../src/internal-types/index.js";

const mocks = vi.hoisted(() => ({
  findByIdInWorkspace: vi.fn(),
  markClosed: vi.fn(),
  append: vi.fn(),
  setActive: vi.fn(),
  findActiveForSession: vi.fn(),
  cancelRun: vi.fn(),
  listForSession: vi.fn(),
  deleteForSession: vi.fn(),
  destroyContainer: vi.fn(),
}));

vi.mock("../../../src/data/index.js", () => ({
  SessionRepository: vi.fn().mockImplementation(() => ({
    findByIdInWorkspace: mocks.findByIdInWorkspace,
    markClosed: mocks.markClosed,
  })),
  SessionEventRepository: vi.fn().mockImplementation(() => ({
    append: mocks.append,
  })),
  SessionRuntimeRepository: vi.fn().mockImplementation(() => ({
    setActive: mocks.setActive,
  })),
  SessionRunRepository: vi.fn().mockImplementation(() => ({
    findActiveForSession: mocks.findActiveForSession,
    cancel: mocks.cancelRun,
  })),
  ContainerContextRepository: vi.fn().mockImplementation(() => ({
    listForSession: mocks.listForSession,
    deleteForSession: mocks.deleteForSession,
  })),
  InputQueueRepository: vi.fn(),
}));

vi.mock("../../../src/modules/tools/container/client.js", () => ({
  destroyContainer: mocks.destroyContainer,
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

describe("handleKillSession", () => {
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
        containerId: "container-1",
        workspaceId: "workspace-1",
        sessionId: "session-1",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ]);
    mocks.destroyContainer.mockResolvedValue(undefined);
    mocks.deleteForSession.mockResolvedValue(undefined);
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
    expect(mocks.deleteForSession).toHaveBeenCalledWith("workspace-1", "session-1", "container-1");
    expect(mocks.markClosed).toHaveBeenCalledWith("session-1", "user");
    expect(mocks.setActive).toHaveBeenCalledWith("session-1", false);
  });
});
