import type { Message, MessageContentBlock, MessageRole, MessageStatus, SessionEvent, ToolResult } from "@clawflare/types";
import { describe, expect, it } from "vitest";

import { applyAssistantPartialEvents, formatMessageForDisplay, getEventDisplayMessage, type DisplayMessage } from "../src/lib/format";

describe("message formatting", () => {
  it("preserves message identity for rendered messages", () => {
    const formatted = formatMessageForDisplay(message({
      id: "assistant-1",
      sequence: 2,
      role: "assistant",
      status: "complete",
      content: [{ type: "text", text: "Done" }],
    }));

    expect(formatted).toMatchObject({
      id: "assistant-1",
      sequence: 2,
      role: "assistant",
      content: "Done",
      streaming: false,
    });
  });

  it("applies assistant partial events to the matching message id", () => {
    const messages: DisplayMessage[] = [
      {
        id: "assistant-1",
        sequence: 2,
        role: "assistant",
        content: "",
        streaming: true,
        toolCalls: [
          {
            id: "tool-1",
            name: "search",
            params: { query: "netlify" },
            status: "running",
          },
        ],
      },
      { id: "user-2", sequence: 3, role: "user", content: "next prompt", streaming: false },
      { id: "assistant-2", sequence: 4, role: "assistant", content: "Thinking", streaming: true },
    ];

    const next = applyAssistantPartialEvents(messages, [
      event("message.completed", message({
        id: "assistant-1",
        sequence: 2,
        role: "assistant",
        status: "complete",
        content: [
          toolCallBlock({
            id: "tool-1",
            status: "complete",
            result: {
              output: { results: [] },
              text: "No matches",
              isError: false,
              completedAt: 10,
            },
          }),
        ],
      })),
    ]);

    expect(next.map((item) => item.id)).toEqual(["assistant-1", "user-2", "assistant-2"]);
    expect(next[0]?.toolCalls?.[0]?.status).toBe("complete");
    expect(next[0]?.toolCalls?.[0]?.result?.content).toBe("No matches");
    expect(next[2]).toMatchObject({ id: "assistant-2", content: "Thinking", streaming: true });
  });

  it("inserts newly visible assistant events by sequence", () => {
    const next = applyAssistantPartialEvents(
      [
        { id: "user-1", sequence: 1, role: "user", content: "hello", streaming: false },
        { id: "user-2", sequence: 3, role: "user", content: "again", streaming: false },
      ],
      [
        event("message.created", message({
          id: "assistant-1",
          sequence: 2,
          role: "assistant",
          status: "streaming",
          content: [{ type: "text", text: "hi" }],
        })),
      ],
    );

    expect(next.map((item) => item.id)).toEqual(["user-1", "assistant-1", "user-2"]);
    expect(next[1]).toMatchObject({ content: "hi", streaming: true });
  });

  it("keeps optimistic messages in insertion order until they receive a sequence", () => {
    const next = applyAssistantPartialEvents(
      [{ role: "user", content: "hello" }],
      [
        event("message.created", message({
          id: "assistant-1",
          sequence: 2,
          role: "assistant",
          status: "streaming",
          content: [{ type: "text", text: "hi" }],
        })),
      ],
    );

    expect(next.map((item) => item.role)).toEqual(["user", "assistant"]);
    expect(next[1]).toMatchObject({ id: "assistant-1", content: "hi" });
  });

  it("formats aborted tool calls distinctly from errors", () => {
    const abortedMessage = message({
      id: "assistant-1",
      sequence: 2,
      role: "assistant",
      status: "complete",
      content: [
        toolCallBlock({
          id: "tool-1",
          status: "aborted",
          result: {
            output: { details: { ok: false, aborted: true } },
            text: "Tool aborted by user.",
            isError: true,
            isAborted: true,
            completedAt: 10,
          },
        }),
      ],
    });

    const formatted = formatMessageForDisplay(abortedMessage);

    expect(formatted.toolCalls?.[0]).toMatchObject({
      id: "tool-1",
      status: "aborted",
      result: {
        isError: true,
        content: "Tool aborted by user.",
      },
    });
    expect(getEventDisplayMessage(event("message.updated", abortedMessage))).toBe("Aborted search");
  });
});

function event(type: "message.created" | "message.updated" | "message.completed", eventMessage: Message): SessionEvent {
  return {
    type,
    message: eventMessage,
    timestamp: eventMessage.updatedAt,
    sequence: eventMessage.sequence,
  };
}

function message(options: {
  id: string;
  sequence: number;
  role: MessageRole;
  status: MessageStatus;
  content: MessageContentBlock[];
}): Message {
  return {
    id: options.id,
    sessionId: "session-1",
    sequence: options.sequence,
    role: options.role,
    status: options.status,
    content: options.content,
    createdAt: 1,
    updatedAt: 2,
  };
}

function toolCallBlock(options: {
  id: string;
  status: "queued" | "running" | "complete" | "error" | "aborted";
  result?: ToolResult;
}): MessageContentBlock {
  return {
    type: "tool_call",
    id: options.id,
    name: "search",
    input: { query: "netlify" },
    status: options.status,
    result: options.result,
  };
}
