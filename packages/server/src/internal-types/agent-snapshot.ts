// Agent snapshot types - compact persisted state for Durable Object storage
// These types are designed to be small and safe to persist

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionStatus, QueueMode } from "./session.js";

/**
 * Schema version for snapshots (allows migrations)
 */
export const CURRENT_SNAPSHOT_VERSION = 1;

/**
 * Persisted tool call reference
 */
export interface PersistedToolCall {
  id: string;
  name: string;
  status: "pending" | "running" | "complete" | "error";
  resultPreview?: string;
  resultSize?: number;
  errorMessage?: string;
}

/**
 * Persisted turn state
 */
export interface PersistedTurn {
  id: string;
  index: number;
  status: "awaiting_assistant" | "awaiting_tools" | "complete" | "error";
  assistantMessageId?: string;
  toolCallIds: string[];
}

/**
 * Persisted message - AgentMessage with size limits
 */
export interface PersistedAgentMessage {
  id: string;
  role: AgentMessage["role"];
  content: unknown[];
  timestamp: number;
  persistedAt: number;
  contentTruncated?: boolean;
  originalSize?: number;
}

/**
 * Pending turn information for resuming
 */
export interface PersistedPendingTurn {
  turnId: string;
  awaiting: "assistant" | "tools";
  partialContent?: string;
  toolCallsPending?: string[];
}

/**
 * Agent session snapshot - compact persisted state
 * This is the only shape stored under workflow session keys
 */
export interface AgentSessionSnapshot {
  schemaVersion: typeof CURRENT_SNAPSHOT_VERSION;
  id: string;
  createdAt: number;
  updatedAt: number;
  status: SessionStatus;
  errorMessage?: string;

  // Model info (not full object)
  modelId: string;
  provider?: string;
  thinkingLevel: string;

  // Messages with size limits
  messages: PersistedAgentMessage[];
  messageCount: number;

  // Steering/Follow-up queues (truncated)
  steeringQueue: PersistedAgentMessage[];
  followUpQueue: PersistedAgentMessage[];
  steeringMode: QueueMode;
  followUpMode: QueueMode;

  // Compact turn state
  turns: PersistedTurn[];
  toolCalls: Record<string, PersistedToolCall>;

  // Pending state for resuming
  pending?: PersistedPendingTurn;

  // System prompt hash for dedup
  systemPromptHash: string;
}

/**
 * Storage constants
 */
export const MAX_STORAGE_SIZE = 130000;
export const MAX_MESSAGE_CONTENT_SIZE = 10000;
export const MAX_SNAPSHOT_MESSAGES = 100;
export const MAX_QUEUE_MESSAGES = 10;

/**
 * Truncate message content to safe size
 */
function truncateContent(content: unknown[]): unknown[] {
  return content.map(item => {
    if (item && typeof item === "object" && "type" in item) {
      const typed = item as { type: string; text?: string };
      if (typed.type === "text" && typed.text && typed.text.length > MAX_MESSAGE_CONTENT_SIZE) {
        return {
          ...typed,
          text: typed.text.slice(0, MAX_MESSAGE_CONTENT_SIZE) + "... [truncated]",
          truncated: true,
        };
      }
    }
    return item;
  });
}

/**
 * Check if a message is a standard pi-ai message (with content, role, timestamp)
 * vs a custom message type
 */
function isStandardMessage(msg: AgentMessage): msg is Extract<AgentMessage, { role: unknown; content: unknown; timestamp: number }> {
  return (
    typeof msg === "object" &&
    msg !== null &&
    "role" in msg &&
    "content" in msg &&
    "timestamp" in msg
  );
}

/**
 * Convert a message to persisted form with size limits
 */
export function persistMessage(msg: AgentMessage, id: string): PersistedAgentMessage {
  if (!isStandardMessage(msg)) {
    // Custom messages - store minimal representation
    return {
      id,
      role: "custom",
      content: [],
      timestamp: Date.now(),
      persistedAt: Date.now(),
      contentTruncated: false,
      originalSize: 0,
    };
  }

  const content = Array.isArray(msg.content)
    ? truncateContent(msg.content as unknown[])
    : [{ type: "text", text: String(msg.content).slice(0, MAX_MESSAGE_CONTENT_SIZE) }];

  const originalSize = JSON.stringify(msg.content).length;
  const persistedSize = JSON.stringify(content).length;

  return {
    id,
    role: msg.role,
    content: content as unknown[],
    timestamp: msg.timestamp,
    persistedAt: Date.now(),
    contentTruncated: persistedSize < originalSize,
    originalSize,
  };
}

/**
 * Trim messages to maximum snapshot size
 */
export function trimMessagesForSnapshot(
  messages: AgentMessage[]
): { messages: PersistedAgentMessage[]; count: number } {
  // Keep last N messages for context
  const toKeep = messages.slice(-MAX_SNAPSHOT_MESSAGES);
  const persisted = toKeep.map((msg, idx) =>
    persistMessage(msg, `msg_${idx}`)
  );

  return {
    messages: persisted,
    count: messages.length,
  };
}
