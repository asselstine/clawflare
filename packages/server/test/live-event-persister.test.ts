import { describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { LiveAgentEventPersister } from "../src/runtime/live-event-persister.js";

function messageUpdate(text: string): AgentEvent {
  return {
    type: "message_update",
    message: {
      id: "message-1",
      role: "assistant",
      content: [{ type: "text", text }],
      timestamp: 1,
    },
    assistantMessageEvent: {
      type: "delta",
      partial: {
        id: "message-1",
        role: "assistant",
        content: [{ type: "text", text }],
        timestamp: 1,
      },
    },
  } as unknown as AgentEvent;
}

function messageEnd(text: string): AgentEvent {
  return {
    type: "message_end",
    message: {
      id: "message-1",
      role: "assistant",
      content: [{ type: "text", text }],
      timestamp: 1,
    },
  } as unknown as AgentEvent;
}

function toolUpdate(toolCallId: string, text: string): AgentEvent {
  return {
    type: "tool_execution_update",
    toolCallId,
    toolName: "execute_code",
    args: {},
    partialResult: { content: [{ type: "text", text }] },
  } as AgentEvent;
}

describe("LiveAgentEventPersister", () => {
  it("coalesces repeated message updates until a boundary event", async () => {
    const appended: AgentEvent[][] = [];
    const first = messageUpdate("h");
    const second = messageUpdate("hi");
    const end = messageEnd("hi");
    const persister = new LiveAgentEventPersister(async (events) => {
      appended.push(events);
    });

    await persister.onEvent(first);
    await persister.onEvent(second);
    expect(appended).toEqual([]);

    await persister.onEvent(end);

    expect(appended).toEqual([[second], [end]]);
    expect(persister.hasHandled(first)).toBe(true);
    expect(persister.hasHandled(second)).toBe(true);
    expect(persister.hasHandled(end)).toBe(true);
  });

  it("flushes coalesced updates at a deterministic threshold", async () => {
    const appended: AgentEvent[][] = [];
    const first = messageUpdate("h");
    const second = messageUpdate("hi");
    const third = messageUpdate("hit");
    const persister = new LiveAgentEventPersister(async (events) => {
      appended.push(events);
    }, 3);

    await persister.onEvent(first);
    await persister.onEvent(second);
    await persister.onEvent(third);

    expect(appended).toEqual([[third]]);
  });

  it("flushes the latest coalesced update after the update interval", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      const appended: AgentEvent[][] = [];
      const first = messageUpdate("h");
      const second = messageUpdate("hi");
      const persister = new LiveAgentEventPersister(async (events) => {
        appended.push(events);
      }, 10, 100);

      await persister.onEvent(first);
      expect(appended).toEqual([]);

      vi.setSystemTime(150);
      await persister.onEvent(second);

      expect(appended).toEqual([[second]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves tool update order because tool updates may be deltas", async () => {
    const appended: AgentEvent[][] = [];
    const firstToolUpdate = toolUpdate("tool-1", "one");
    const secondToolUpdate = toolUpdate("tool-1", "two");
    const otherToolUpdate = toolUpdate("tool-2", "other");
    const toolEnd: AgentEvent = {
      type: "tool_execution_end",
      toolCallId: "tool-1",
      toolName: "execute_code",
      result: { content: [{ type: "text", text: "done" }] },
      isError: false,
    } as AgentEvent;
    const persister = new LiveAgentEventPersister(async (events) => {
      appended.push(events);
    });

    await persister.onEvent(firstToolUpdate);
    await persister.onEvent(secondToolUpdate);
    await persister.onEvent(otherToolUpdate);
    await persister.onEvent(toolEnd);

    expect(appended).toEqual([[firstToolUpdate], [secondToolUpdate], [otherToolUpdate], [toolEnd]]);
  });
});
