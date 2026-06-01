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
  name?: string;
  status: SessionStatus;
  messages: AgentMessage[];
  events: SessionEvent[];
  nextEventCursor: string;
  errorMessage?: string;
}

export interface SessionSummary {
  id: string;
  workspaceId: string;
  name?: string;
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
  eventCursor: string;
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

export type ModelProvider = string;

export interface ProviderInfo {
  id: string;
  name: string;
  requiredSecrets: string[];
  optionalSecrets: string[];
}

export interface ProviderModelInfo {
  id: string;
  name: string;
  api: string;
  provider: string;
  input: string[];
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
}

export interface ProviderListResponse {
  providers: ProviderInfo[];
}

export interface ProviderModelsResponse {
  provider: string;
  models: ProviderModelInfo[];
}

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

export interface ServerInfo {
  contextWindow: number;
  supportsWorkspaceModelConnections: boolean;
  supportedProviders: string[];
  workspace?: {
    hasModelConnections: boolean;
  };
}
