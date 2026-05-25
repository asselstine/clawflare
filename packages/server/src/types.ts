// Public types exported for clients
// These types can be imported by non-Workers environments (CLI, etc.)

import type { AgentMessage as PiAgentMessage } from "@earendil-works/pi-agent-core";

export type {
  AgentMessage,
  SessionEvent,
  SessionStatus,
  ChatRequest,
  ChatSubmittedResponse,
  SessionResponse,
  SessionSummary,
  SessionListResponse,
  CreateSessionRequest,
  CreateSessionResponse,
  ToolDefinition,
  ModelProvider,
  ModelConnection,
  ModelConnectionListResponse,
  CreateModelConnectionRequest,
  UpdateModelConnectionRequest,
  SetDefaultModelConnectionRequest,
} from "@clawflare/types";

export type AgentSession = {
  id: string;
  parentId?: string;
  messages: PiAgentMessage[];
  createdAt: number;
};
