// Public types exported for clients
// These types can be imported by non-Workers environments (CLI, etc.)

import type { AgentMessage as PiAgentMessage } from "@earendil-works/pi-agent-core";

export type { AgentMessage } from "@earendil-works/pi-agent-core";

export type {
  Message,
  MessageContentBlock,
  MessageRole,
  MessageStatus,
  SessionDelta,
  SessionEvent,
  SessionStatus,
  TextContentBlock,
  ToolCallContentBlock,
  ToolCallStatus,
  ToolResult,
  ChatRequest,
  ChatSubmittedResponse,
  SessionResponse,
  SessionSummary,
  SessionListResponse,
  CreateSessionRequest,
  CreateSessionResponse,
  KillSessionResponse,
  DeleteSessionResponse,
  DeleteSessionsResponse,
  ToolDefinition,
  ModelProvider,
  Model,
  ModelListResponse,
  CreateModelRequest,
  UpdateModelRequest,
  SetDefaultModelRequest,
} from "@clawflare/types";

export type AgentSession = {
  id: string;
  parentId?: string;
  messages: PiAgentMessage[];
  createdAt: number;
};
