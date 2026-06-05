import { describe, expect, it, vi } from "vitest";
import {
  ClawflareTUIApp,
  applyAssistantPartialEvents,
  getActiveToolCallStatusMessage,
  getEventDisplayMessage,
  getPersistedToolResultIsError,
  getToolCallVisualState,
  shouldShowTrailingThinking,
  updateToolCallStatusesFromEvents,
} from "../src/tui-app.js";

describe("getPersistedToolResultIsError", () => {
  it("treats persisted execution details with ok false as an error", () => {
    expect(getPersistedToolResultIsError({ isError: false, details: { ok: false } })).toBe(true);
  });
});

describe("getToolCallVisualState", () => {
  it("treats a pending tool call with a result as complete", () => {
    expect(getToolCallVisualState("pending", { isError: false })).toEqual({
      hasError: false,
      isComplete: true,
    });
  });

  it("keeps running tool calls without results incomplete", () => {
    expect(getToolCallVisualState("running", undefined)).toEqual({
      hasError: false,
      isComplete: false,
    });
  });

  it("shows ended failed tool calls as errors before result messages arrive", () => {
    expect(getToolCallVisualState("error", undefined)).toEqual({
      hasError: true,
      isComplete: false,
    });
  });

  it("shows ended successful tool calls as complete before result messages arrive", () => {
    expect(getToolCallVisualState("complete", undefined)).toEqual({
      hasError: false,
      isComplete: true,
    });
  });

  it("uses result errors even when the status was not updated", () => {
    expect(getToolCallVisualState("pending", { isError: true })).toEqual({
      hasError: true,
      isComplete: false,
    });
  });
});

describe("updateToolCallStatusesFromEvents", () => {
  it("marks tool calls as failed from end events", () => {
    const toolCalls = [{
      id: "tool-1",
      name: "execute_code",
      params: {},
      status: "running" as const,
    }];

    updateToolCallStatusesFromEvents(toolCalls, [{
      type: "message.updated",
      message: {
        id: "assistant-1",
        sessionId: "session-1",
        sequence: 1,
        role: "assistant",
        status: "complete",
        content: [{
          type: "tool_call",
          id: "tool-1",
          name: "execute_code",
          input: {},
          status: "error",
          result: { output: {}, text: "failed", isError: true, completedAt: 1 },
        }],
        createdAt: 1,
        updatedAt: 1,
      },
      timestamp: Date.now(),
      sequence: 1,
    } as never]);

    expect(toolCalls[0]?.status).toBe("error");
  });
});

describe("getActiveToolCallStatusMessage", () => {
  it("reports queued tool calls after an assistant response ends with tools", () => {
    expect(getActiveToolCallStatusMessage([{
      role: "assistant",
      toolCalls: [{
        id: "tool-1",
        name: "execute_code",
        params: {},
        status: "pending",
      }],
    }])).toBe("Waiting to run execute_code");
  });

  it("reports running tool calls", () => {
    expect(getActiveToolCallStatusMessage([{
      role: "assistant",
      toolCalls: [{
        id: "tool-1",
        name: "execute_code",
        params: {},
        status: "running",
      }],
    }])).toBe("Running execute_code");
  });

  it("ignores completed tool calls", () => {
    expect(getActiveToolCallStatusMessage([{
      role: "assistant",
      toolCalls: [{
        id: "tool-1",
        name: "execute_code",
        params: {},
        status: "complete",
      }],
    }])).toBeNull();
  });
});

describe("shouldShowTrailingThinking", () => {
  it("shows thinking after the last tool result while loading", () => {
    expect(shouldShowTrailingThinking(true, [
      { role: "assistant", toolCalls: [{}] },
      { role: "toolResult" },
    ])).toBe(true);
  });

  it("does not show thinking while another tool call is still pending", () => {
    expect(shouldShowTrailingThinking(true, [
      { role: "assistant", toolCalls: [{}, {}] },
      { role: "toolResult" },
    ])).toBe(false);
  });

  it("does not show thinking when not loading", () => {
    expect(shouldShowTrailingThinking(false, [
      { role: "assistant", toolCalls: [{}] },
      { role: "toolResult" },
    ])).toBe(false);
  });
});

describe("getEventDisplayMessage", () => {
  it("does not describe user prompt message events as response updates", () => {
    expect(getEventDisplayMessage({
      type: "message.completed",
      message: { role: "user", content: [{ type: "text", text: "hello" }] },
    } as never)).toBeNull();
  });

  it("keeps assistant message status stable while streaming", () => {
    expect(getEventDisplayMessage({
      type: "message.created",
      message: { role: "assistant", status: "streaming", content: [{ type: "text", text: "" }] },
    } as never)).toBe("Generating response...");
    expect(getEventDisplayMessage({
      type: "message.updated",
      message: { role: "assistant", status: "streaming", content: [{ type: "text", text: "hel" }] },
    } as never)).toBe("Generating response...");
    expect(getEventDisplayMessage({
      type: "message.completed",
      message: { role: "assistant", status: "complete", content: [{ type: "text", text: "hello" }] },
    } as never)).toBe("Response ready");
  });
});

describe("applyAssistantPartialEvents", () => {
  it("adds and updates an in-progress assistant message from stream events", () => {
    const result = applyAssistantPartialEvents([
      { role: "user", content: "hello" },
    ], [
      {
        type: "message.created",
        message: { role: "assistant", status: "streaming", content: [{ type: "text", text: "" }] },
        timestamp: Date.now(),
        sequence: 1,
      },
      {
        type: "message.updated",
        message: { role: "assistant", status: "streaming", content: [{ type: "text", text: "streaming" }] },
        timestamp: Date.now(),
        sequence: 2,
      },
    ] as never);

    expect(result.messages).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "streaming", streaming: true, toolCalls: undefined },
    ]);
    expect(result.state.active).toBe(true);
  });

  it("reuses a trailing completed assistant message instead of duplicating it", () => {
    const result = applyAssistantPartialEvents([
      { role: "user", content: "hello" },
      { role: "assistant", content: "final" },
    ], [
      {
        type: "message.created",
        message: { role: "assistant", status: "streaming", content: [{ type: "text", text: "" }] },
        timestamp: Date.now(),
        sequence: 1,
      },
      {
        type: "message.completed",
        message: { role: "assistant", status: "complete", content: [{ type: "text", text: "final" }] },
        timestamp: Date.now(),
        sequence: 2,
      },
    ] as never);

    expect(result.messages).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "final", streaming: false, toolCalls: undefined },
    ]);
    expect(result.state.active).toBe(false);
  });
});

describe("ClawflareTUIApp", () => {
  function createMockClient(overrides: Record<string, unknown> = {}) {
    return {
      getUrl: () => "https://example.com",
      getServerInfo: vi.fn().mockResolvedValue({
        contextWindow: 128000,
        supportedProviders: [],
        supportsWorkspaceModels: true,
        workspace: { hasModels: true },
      }),
      createSession: vi.fn().mockResolvedValue({
        id: "session-current",
        workspaceId: "workspace-1",
        eventCursor: "0",
        createdAt: Date.now(),
      }),
      setCurrentSessionId: vi.fn(),
      ...overrides,
    };
  }

  it("keeps prompt text visible instead of submitting while already polling", () => {
    const client = createMockClient({
      submitChat: vi.fn(),
    });

    const app = new ClawflareTUIApp(client as never);
    const appInternals = app as unknown as {
      isLoading: boolean;
      editor: { setText(text: string): void };
      sendPrompt(displayContent: string, actualContent: string): void;
    };
    const setText = vi.spyOn(appInternals.editor, "setText");
    appInternals.isLoading = true;

    appInternals.sendPrompt("next prompt", "next prompt");

    expect(client.submitChat).not.toHaveBeenCalled();
    expect(setText).toHaveBeenCalledWith("next prompt");
  });

  it("starts a session selector when opening without a session id", async () => {
    const currentSessionId = "0".repeat(32);
    const nextSessionId = "1".repeat(32);
    const client = createMockClient({
      listSessions: vi.fn().mockResolvedValue({
        sessions: [
          {
            id: currentSessionId,
            name: "Current",
            status: "idle",
            isActive: true,
            messageCount: 1,
            updatedAt: Date.now(),
          },
          {
            id: nextSessionId,
            name: "Next",
            status: "idle",
            isActive: false,
            messageCount: 2,
            updatedAt: Date.now(),
          },
        ],
        total: 2,
      }),
    });

    const app = new ClawflareTUIApp(client as never);
    const appInternals = app as unknown as {
      sessionId: string;
      sessionSelector: { selectedIndex: number; sessions: Array<{ id: string }> } | null;
      beginOpenSessionSelection(): Promise<boolean>;
    };
    appInternals.sessionId = currentSessionId;

    await expect(appInternals.beginOpenSessionSelection()).resolves.toBe(true);

    expect(appInternals.sessionSelector?.selectedIndex).toBe(1);
    expect(appInternals.sessionSelector?.sessions.map((session) => session.id)).toEqual([
      currentSessionId,
      nextSessionId,
    ]);
  });

  it("opens the selected session with arrow navigation and enter", async () => {
    const currentSessionId = "0".repeat(32);
    const nextSessionId = "1".repeat(32);
    const client = createMockClient({
      getSession: vi.fn().mockResolvedValue({
        id: nextSessionId,
        name: "Next",
        messages: [],
        events: [],
      }),
    });

    const app = new ClawflareTUIApp(client as never);
    const appInternals = app as unknown as {
      sessionId: string;
      sessionSelector: { selectedIndex: number; sessions: Array<{ id: string }> } | null;
      handleSessionSelectorInput(data: string): void;
    };
    appInternals.sessionId = currentSessionId;
    appInternals.sessionSelector = {
      selectedIndex: 0,
      total: 2,
      sessions: [
        {
          id: currentSessionId,
          name: "Current",
          status: "idle",
          isActive: true,
          messageCount: 1,
          updatedAt: Date.now(),
        },
        {
          id: nextSessionId,
          name: "Next",
          status: "idle",
          isActive: false,
          messageCount: 2,
          updatedAt: Date.now(),
        },
      ],
    } as never;

    appInternals.handleSessionSelectorInput("\u001b[B");
    appInternals.handleSessionSelectorInput("\r");
    await vi.waitFor(() => expect(client.getSession).toHaveBeenCalledWith(nextSessionId));

    expect(client.setCurrentSessionId).toHaveBeenCalledWith(nextSessionId);
    expect(appInternals.sessionId).toBe(nextSessionId);
    expect(appInternals.sessionSelector).toBeNull();
  });

  it("kills all non-terminal sessions across pages", async () => {
    const currentSessionId = "0".repeat(32);
    const processingSessionId = "1".repeat(32);
    const closedSessionId = "2".repeat(32);
    const idleSessionId = "3".repeat(32);
    const listSessions = vi.fn()
      .mockResolvedValueOnce({
        sessions: [
          {
            id: currentSessionId,
            name: "Current",
            status: "processing",
            isActive: true,
            messageCount: 1,
            updatedAt: Date.now(),
          },
          {
            id: processingSessionId,
            name: "Work",
            status: "processing",
            isActive: true,
            messageCount: 2,
            updatedAt: Date.now(),
          },
        ],
        total: 4,
      })
      .mockResolvedValueOnce({
        sessions: [
          {
            id: closedSessionId,
            name: "Closed",
            status: "closed",
            isActive: false,
            messageCount: 3,
            updatedAt: Date.now(),
          },
          {
            id: idleSessionId,
            name: "Idle",
            status: "idle",
            isActive: false,
            messageCount: 4,
            updatedAt: Date.now(),
          },
        ],
        total: 4,
      });
    const killSession = vi.fn(async (sessionId: string) => ({
      ok: true,
      sessionId,
      workspaceId: "workspace-1",
      status: "closed",
      workflowTerminated: true,
      destroyedContainers: [],
      errors: [],
    }));
    const client = createMockClient({
      listSessions,
      killSession,
    });

    const app = new ClawflareTUIApp(client as never);
    const appInternals = app as unknown as {
      sessionId: string;
      killAllSessions(): Promise<{ killed: Array<{ sessionId: string }>; skipped: Array<{ id: string }> }>;
    };
    appInternals.sessionId = currentSessionId;

    const result = await appInternals.killAllSessions();

    expect(listSessions).toHaveBeenNthCalledWith(1, { status: "all", limit: 100, offset: 0 });
    expect(listSessions).toHaveBeenNthCalledWith(2, { status: "all", limit: 100, offset: 100 });
    expect(killSession).toHaveBeenCalledWith(currentSessionId);
    expect(killSession).toHaveBeenCalledWith(processingSessionId);
    expect(killSession).toHaveBeenCalledWith(idleSessionId);
    expect(killSession).not.toHaveBeenCalledWith(closedSessionId);
    expect(result.killed.map((session) => session.sessionId)).toEqual([
      currentSessionId,
      processingSessionId,
      idleSessionId,
    ]);
    expect(result.skipped.map((session) => session.id)).toEqual([closedSessionId]);
  });
});
