import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  Message,
  MessageContentBlock,
  MessageRole,
  MessageStatus,
  SessionDelta,
  ToolCallContentBlock,
  ToolResult,
} from "../types.js";
import {
  SessionEventRepository,
  SessionMessageRepository,
  type NewSessionEvent,
} from "../data/index.js";

export interface ProjectAgentEventsOptions {
  workspaceId?: string;
}

export async function projectAndAppendAgentEvents(
  eventsRepo: SessionEventRepository,
  messagesRepo: SessionMessageRepository,
  sessionId: string,
  agentEvents: AgentEvent[],
  options: ProjectAgentEventsOptions = {},
): Promise<void> {
  const deltas: NewSessionEvent[] = [];

  for (const agentEvent of agentEvents) {
    const timestamp = messageTimestamp(agentEvent) ?? Date.now();
    const delta = await projectAgentEvent(messagesRepo, sessionId, agentEvent, timestamp, options.workspaceId);
    if (delta) {
      deltas.push({ ...delta, timestamp });
    }
  }

  await eventsRepo.append(sessionId, deltas);
}

export async function appendSessionStatusEvent(
  eventsRepo: SessionEventRepository,
  sessionId: string,
  delta: Extract<SessionDelta, { type: "session.status_changed" }>,
): Promise<void> {
  await eventsRepo.append(sessionId, [{ ...delta, timestamp: Date.now() }]);
}

async function projectAgentEvent(
  messagesRepo: SessionMessageRepository,
  sessionId: string,
  event: AgentEvent,
  timestamp: number,
  workspaceId?: string,
): Promise<SessionDelta | null> {
  if ("message" in event && (event.type === "message_start" || event.type === "message_update" || event.type === "message_end")) {
    return projectMessageEvent(messagesRepo, sessionId, event.type, event.message as AgentMessage, timestamp, workspaceId);
  }

  if (event.type === "tool_execution_start") {
    return updateToolCall(messagesRepo, sessionId, event.toolCallId, timestamp, (block) => ({
      ...block,
      status: "running",
    }));
  }

  if (event.type === "tool_execution_update") {
    return updateToolCall(messagesRepo, sessionId, event.toolCallId, timestamp, (block) => ({
      ...block,
      status: "running",
    }));
  }

  if (event.type === "tool_execution_end") {
    return updateToolCall(messagesRepo, sessionId, event.toolCallId, timestamp, (block) => ({
      ...block,
      status: event.isError ? "error" : "complete",
      result: toolResultFromAgentResult(event.result, Boolean(event.isError), timestamp),
    }));
  }

  return null;
}

async function projectMessageEvent(
  messagesRepo: SessionMessageRepository,
  sessionId: string,
  eventType: "message_start" | "message_update" | "message_end",
  agentMessage: AgentMessage,
  timestamp: number,
  workspaceId?: string,
): Promise<SessionDelta | null> {
  const role = canonicalRole(agentMessage);
  if (!role) return null;

  const content = canonicalContent(agentMessage);
  const status: MessageStatus = eventType === "message_end" ? "complete" : "streaming";
  const existing = await findExistingMessage(messagesRepo, sessionId, agentMessage, role);

  if (!existing && eventType === "message_update") {
    return null;
  }

  if (!existing) {
    const message = await messagesRepo.create({
      id: stableMessageId(agentMessage, role, timestamp),
      sessionId,
      role,
      status,
      content,
      createdAt: timestamp,
      updatedAt: timestamp,
      workspaceId,
    });

    return {
      type: eventType === "message_end" ? "message.completed" : "message.created",
      message,
    };
  }

  const message = await messagesRepo.update({
    ...existing,
    status,
    content: mergeToolState(content, existing.content),
    updatedAt: timestamp,
  });

  return {
    type: eventType === "message_end" ? "message.completed" : "message.updated",
    message,
  };
}

async function updateToolCall(
  messagesRepo: SessionMessageRepository,
  sessionId: string,
  toolCallId: string,
  timestamp: number,
  update: (block: ToolCallContentBlock) => ToolCallContentBlock,
): Promise<SessionDelta | null> {
  const message = await messagesRepo.findLatestAssistantWithToolCall(sessionId, toolCallId);
  if (!message) return null;

  const content = message.content.map((block: MessageContentBlock) =>
    block.type === "tool_call" && block.id === toolCallId ? update(block) : block
  );
  const updated = await messagesRepo.update({
    ...message,
    content,
    updatedAt: timestamp,
  });

  return { type: "message.updated", message: updated };
}

async function findExistingMessage(
  messagesRepo: SessionMessageRepository,
  sessionId: string,
  message: AgentMessage,
  role: MessageRole,
): Promise<Message | null> {
  const explicitId = agentMessageId(message);
  if (explicitId) {
    const existing = await messagesRepo.findById(sessionId, explicitId);
    if (existing) return existing;
  }

  if (role === "assistant") {
    return messagesRepo.findLatestStreamingAssistant(sessionId);
  }

  return messagesRepo.findById(sessionId, stableMessageId(message, role, messageTimestampFromMessage(message) ?? Date.now()));
}

function canonicalRole(message: AgentMessage): MessageRole | null {
  if (message.role === "user" || message.role === "assistant") return message.role;
  if (message.role === "toolResult") return null;
  return null;
}

function canonicalContent(message: AgentMessage): MessageContentBlock[] {
  const content = getMessageContent(message);
  if (!Array.isArray(content)) {
    return typeof content === "string" ? [{ type: "text", text: content }] : [];
  }

  return content.flatMap((part): MessageContentBlock[] => {
    if (!isRecord(part)) return [];
    if (part.type === "text") {
      return [{ type: "text", text: typeof part.text === "string" ? part.text : "" }];
    }
    if (part.type === "toolCall") {
      return [{
        type: "tool_call",
        id: typeof part.id === "string" ? part.id : stableTextHash(JSON.stringify(part)),
        name: typeof part.name === "string" ? part.name : "tool",
        input: isRecord(part.arguments) ? part.arguments : {},
        status: "queued",
      }];
    }
    return [];
  });
}

function mergeToolState(next: MessageContentBlock[], previous: MessageContentBlock[]): MessageContentBlock[] {
  return next.map((block) => {
    if (block.type !== "tool_call") return block;
    const previousBlock = previous.find((candidate) => candidate.type === "tool_call" && candidate.id === block.id);
    if (!previousBlock || previousBlock.type !== "tool_call") return block;
    return {
      ...block,
      status: previousBlock.status,
      result: previousBlock.result,
    };
  });
}

function toolResultFromAgentResult(result: unknown, isError: boolean, timestamp: number): ToolResult {
  return {
    output: result,
    text: extractResultText(result),
    isError,
    completedAt: timestamp,
  };
}

function extractResultText(result: unknown): string | undefined {
  if (!isRecord(result) || !Array.isArray(result.content)) return undefined;
  return result.content
    .filter(isRecord)
    .filter((part) => part.type === "text")
    .map((part) => typeof part.text === "string" ? part.text : "")
    .join("");
}

function stableMessageId(message: AgentMessage, role: MessageRole, timestamp: number): string {
  return agentMessageId(message) ?? `msg_${role}_${timestamp}_${stableTextHash(JSON.stringify(getMessageContent(message) ?? ""))}`;
}

function agentMessageId(message: AgentMessage): string | undefined {
  return isRecord(message) && typeof message.id === "string" ? message.id : undefined;
}

function messageTimestamp(event: AgentEvent): number | undefined {
  if (!("message" in event) || !isRecord(event.message)) return undefined;
  return typeof event.message.timestamp === "number" ? event.message.timestamp : undefined;
}

function messageTimestampFromMessage(message: AgentMessage): number | undefined {
  return isRecord(message) && typeof message.timestamp === "number" ? message.timestamp : undefined;
}

function getMessageContent(message: AgentMessage): unknown {
  return isRecord(message) ? message.content : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableTextHash(value: string): string {
  let hash = 5381;
  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) + hash) ^ value.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
}
