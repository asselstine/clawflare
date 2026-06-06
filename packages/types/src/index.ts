import type { AgentMessage } from "@earendil-works/pi-agent-core";

export type { AgentMessage, AgentEvent } from "@earendil-works/pi-agent-core";

export type MessageRole = "user" | "assistant" | "system";

export type MessageStatus = "queued" | "streaming" | "complete" | "error";

export type ToolCallStatus = "queued" | "running" | "complete" | "error";

export interface TextContentBlock {
  type: "text";
  text: string;
}

export interface ToolResult {
  output: unknown;
  text?: string;
  isError: boolean;
  startedAt?: number;
  completedAt: number;
}

export interface ToolPartialResult {
  output: unknown;
  text?: string;
  isError?: boolean;
  updatedAt: number;
}

export interface ToolCallContentBlock {
  type: "tool_call";
  id: string;
  name: string;
  input: unknown;
  status: ToolCallStatus;
  partialResult?: ToolPartialResult;
  result?: ToolResult;
}

export type MessageContentBlock = TextContentBlock | ToolCallContentBlock;

export interface Message {
  id: string;
  sessionId: string;
  sequence: number;
  role: MessageRole;
  status: MessageStatus;
  content: MessageContentBlock[];
  createdAt: number;
  updatedAt: number;
}

export type SessionDelta =
  | { type: "message.created"; message: Message }
  | { type: "message.updated"; message: Message }
  | { type: "message.completed"; message: Message }
  | { type: "message.errored"; messageId: string; error: string }
  | { type: "session.status_changed"; status: SessionStatus; errorMessage?: string };

export type SessionEvent = SessionDelta & {
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

export type ContainerStatus = "active" | "destroyed";
export type ContainerSleepStatus = "awake" | "sleeping";

export interface ContainerSummary {
  id: string;
  name?: string;
  status: ContainerStatus;
  description?: string;
  lastActivityAt?: number;
  sleepAfterMs?: number;
  sleepAt?: number;
  sleepStatus?: ContainerSleepStatus;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;
}

export interface ChatRequest {
  content: string;
  sessionId?: string;
  maxTurns?: number;
  modelId?: string;
}

export interface ChatSubmittedResponse {
  sessionId: string;
  workspaceId: string;
  eventCursor: string;
  isNewSession: boolean;
  name?: string;
  model?: {
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
  messages: Message[];
  events: SessionEvent[];
  nextEventCursor: string;
  nextMessageCursor: string;
  promptHistory?: {
    systemPrompt: string;
    messages: AgentMessage[];
  };
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
  modelId?: string;
  containers?: string[];
  containerDetails?: ContainerSummary[];
}

export interface SessionListResponse {
  sessions: SessionSummary[];
  total: number;
}

export interface CreateSessionRequest {
  sessionId?: string;
  modelId?: string;
  parentSessionId?: string;
  parentMessageId?: string;
}

export interface CreateSessionResponse {
  id: string;
  workspaceId: string;
  eventCursor: string;
  createdAt: number;
  model?: {
    id: string;
    provider: ModelProvider;
    modelName: string;
  };
}

export interface KillSessionResponse {
  ok: boolean;
  sessionId: string;
  workspaceId: string;
  status: "closed";
  workflowId?: string;
  workflowStatusBefore?: string;
  workflowTerminated: boolean;
  destroyedContainers: string[];
  errors: string[];
}

export interface DeleteSessionResponse {
  ok: boolean;
  sessionId: string;
  workspaceId: string;
  deleted: boolean;
  killedBeforeDelete: boolean;
  workflowTerminated: boolean;
  destroyedContainers: string[];
  errors: string[];
}

export interface DeleteSessionsResponse {
  ok: boolean;
  workspaceId: string;
  deleted: number;
  total: number;
  results: DeleteSessionResponse[];
  errors: string[];
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

export interface WorkspaceProvider {
  id: string;
  workspaceId: string;
  provider: ModelProvider;
  providerDisplayName?: string;
  configuredSecrets: string[];
  requiredSecrets: string[];
  createdAt: number;
  updatedAt: number;
}

export interface WorkspaceProviderListResponse {
  providers: WorkspaceProvider[];
}

export interface CreateWorkspaceProviderRequest {
  provider: ModelProvider;
  providerDisplayName?: string;
  secrets?: Record<string, string>;
  config?: Record<string, unknown>;
  defaultModelName?: string;
  createDefaultModel?: boolean;
  modelDisplayName?: string;
  modelConfig?: Record<string, unknown>;
  setAsDefault?: boolean;
}

export interface CreateWorkspaceProviderResponse {
  provider: WorkspaceProvider;
  model?: Model;
  defaultModelId?: string;
}

export interface DeleteWorkspaceProviderResponse {
  ok: boolean;
  providerId: string;
  deletedModelIds: string[];
  clearedDefaultModelId?: string;
}

export interface EgressHandlerInfo {
  egressHandlerId: string;
  name: string;
  displayName: string;
  description: string;
  domains: string[];
  enabled: boolean;
  configuredSecrets: string[];
  requiredSecrets: string[];
  optionalSecrets: string[];
  configSchema?: Record<string, unknown>;
  updatedAt: number;
}

export interface EgressHandlerListResponse {
  egressHandlers: EgressHandlerInfo[];
}

export interface EgressHandlerResponse {
  egressHandler: EgressHandlerInfo;
}

export interface DeleteEgressHandlerResponse {
  ok: boolean;
  egressHandlerId: string;
}

export interface ConfigureEgressHandlerRequest {
  egressHandlerId: string;
  secrets?: Record<string, string>;
  config?: Record<string, unknown>;
  enabled?: boolean;
}

export interface UpdateEgressHandlerRequest {
  secrets?: Record<string, string>;
  config?: Record<string, unknown>;
  enabled?: boolean;
}

export interface Model {
  id: string;
  workspaceId: string;
  providerId: string;
  displayName?: string;
  provider: ModelProvider;
  providerDisplayName?: string;
  modelName: string;
  configuredSecrets: string[];
  requiredSecrets: string[];
  createdAt: number;
  updatedAt: number;
}

export interface ModelListResponse {
  models: Model[];
  defaultModelId?: string;
}

export interface CreateModelRequest {
  displayName?: string;
  provider: ModelProvider;
  providerId?: string;
  providerDisplayName?: string;
  modelName: string;
  secrets?: Record<string, string>;
  config?: Record<string, unknown>;
  providerConfig?: Record<string, unknown>;
  setAsDefault?: boolean;
}

export interface UpdateModelRequest {
  displayName?: string | null;
  modelName?: string;
  secrets?: Record<string, string>;
  config?: Record<string, unknown>;
  providerConfig?: Record<string, unknown>;
}

export interface SetDefaultModelRequest {
  modelId: string | null;
}

export interface CurrentUserResponse {
  user: {
    id: string;
    email: string;
    displayName?: string;
    createdAt: number;
  };
  workspaces: Array<{
    id: string;
    slug: string;
    name: string;
    description?: string | null;
    role?: string;
  }>;
  currentWorkspace: WorkspaceResponse;
}

export interface WorkspaceResponse {
  id: string;
  slug: string;
  name: string;
  description?: string | null;
  role: string;
  defaultModelId?: string | null;
}
