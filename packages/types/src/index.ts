import type { AgentMessage, AgentEvent } from "@earendil-works/pi-agent-core";

export type { AgentMessage, AgentEvent } from "@earendil-works/pi-agent-core";

export type SessionEvent = AgentEvent & {
  timestamp: number;
  sequence: number;
};

export type SessionStatus =
  | "idle"
  | "processing"
  | "awaiting_input"
  | "error"
  | "closed"
  | "expired";

export interface ChatRequest {
  content: string;
  sessionId?: string;
  maxTurns?: number;
  modelConnectionId?: string;
}

export interface ChatSubmittedResponse {
  sessionId: string;
  workspaceId: string;
  eventCursor: string;
  isNewSession: boolean;
  modelConnection?: {
    id: string;
    provider: ModelProvider;
    modelName: string;
  };
}

export interface SessionResponse {
  id: string;
  workspaceId: string;
  status: SessionStatus;
  messages: AgentMessage[];
  events: SessionEvent[];
  nextEventCursor: string;
  errorMessage?: string;
}

export interface SessionSummary {
  id: string;
  workspaceId: string;
  workflowId: string;
  status: SessionStatus;
  messageCount: number;
  updatedAt: number;
  isActive: boolean;
  modelConnectionId?: string;
  modelProvider?: ModelProvider;
  modelName?: string;
}

export interface SessionListResponse {
  sessions: SessionSummary[];
  total: number;
}

export interface CreateSessionRequest {
  sessionId?: string;
  modelConnectionId?: string;
  parentSessionId?: string;
  parentMessageId?: string;
}

export interface CreateSessionResponse {
  id: string;
  workspaceId: string;
  messages: AgentMessage[];
  createdAt: number;
  modelConnection?: {
    id: string;
    provider: ModelProvider;
    modelName: string;
  };
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export type ModelProvider =
  | "amazon-bedrock"
  | "anthropic"
  | "openai"
  | "cloudflare-workers-ai";

export interface ModelConnection {
  id: string;
  workspaceId: string;
  displayName?: string;
  provider: ModelProvider;
  modelName: string;
  configuredSecrets: string[];
  requiredSecrets: string[];
  createdAt: number;
  updatedAt: number;
}

export interface ModelConnectionListResponse {
  modelConnections: ModelConnection[];
  defaultModelConnectionId?: string;
}

export interface CreateModelConnectionRequest {
  displayName?: string;
  provider: ModelProvider;
  modelName: string;
  secrets: Record<string, string>;
  setAsDefault?: boolean;
}

export interface UpdateModelConnectionRequest {
  displayName?: string | null;
  provider?: ModelProvider;
  modelName?: string;
  secrets?: Record<string, string>;
}

export interface SetDefaultModelConnectionRequest {
  modelConnectionId: string | null;
}
