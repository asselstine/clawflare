import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleGetSession } from "../../../src/modules/sessions/sessions.routes.js";
import type { RequestContext } from "../../../src/http/request-context.js";
import type { Env } from "../../../src/internal-types/index.js";

const mocks = vi.hoisted(() => ({
  findByIdInWorkspace: vi.fn(),
  save: vi.fn(),
  listSince: vi.fn(),
  getWorkflowSession: vi.fn(),
}));

vi.mock("../../../src/data/index.js", () => ({
  SessionRepository: vi.fn().mockImplementation(() => ({
    findByIdInWorkspace: mocks.findByIdInWorkspace,
    save: mocks.save,
  })),
  SessionEventRepository: vi.fn().mockImplementation(() => ({
    listSince: mocks.listSince,
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
});
