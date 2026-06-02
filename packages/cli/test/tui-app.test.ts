import { describe, expect, it, vi } from "vitest";
import {
  ClawflareTUIApp,
  getPersistedToolResultIsError,
  getToolCallVisualState,
  shouldShowTrailingThinking,
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

  it("uses result errors even when the status was not updated", () => {
    expect(getToolCallVisualState("pending", { isError: true })).toEqual({
      hasError: true,
      isComplete: false,
    });
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

describe("ClawflareTUIApp", () => {
  it("keeps prompt text visible instead of submitting while already polling", () => {
    const client = {
      getUrl: () => "https://example.com",
      getServerInfo: vi.fn().mockResolvedValue({
        contextWindow: 128000,
        supportedProviders: [],
        supportsWorkspaceModelConnections: true,
        workspace: { hasModelConnections: true },
      }),
      createSession: vi.fn().mockResolvedValue({
        id: "session-1",
        workspaceId: "workspace-1",
        eventCursor: "0",
        createdAt: Date.now(),
      }),
      submitChat: vi.fn(),
    };

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
});
