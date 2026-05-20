// Types for the Clawflare Harness
import type { AgentMessage, AgentEvent } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
export type { AgentMessage } from "@earendil-works/pi-agent-core";

/**
 * SessionEvent - AgentEvent with timestamp and per-session sequence for cursor-based pagination.
 */
export type SessionEvent = AgentEvent & { timestamp: number; sequence: number };

/**
 * SessionState - The current state of an agent session
 * Client polls this to get message history and processing events
 */
export interface SessionState {
  id: string;
  workflowId: string;           // Persistent workflow ID for this session
  status: "idle" | "processing" | "awaiting_input" | "error" | "closed" | "expired";
  messages: AgentMessage[];
  nextEventCursor: string;
  updatedAt: number;
  errorMessage?: string;
  // Session config (stored with defaults)
  maxQueueSize?: number;        // default 100
  idleTimeout?: string;         // default "7 days"
}

/**
 * ChatSubmittedResponse - Returned immediately from POST /v1/chat
 */
export interface ChatSubmittedResponse {
  sessionId: string;
  eventCursor: string;
  isNewSession: boolean;      // NEW: indicates if this created a new session
}

/**
 * SessionEventQueue - Input events queued for a persistent session workflow
 */
export interface SessionEventQueue {
  pending: SessionInputEvent[];
  maxSize: number;
}

/**
 * SessionInputEvent - Events that can be sent to a running session workflow
 */
export type SessionInputEvent =
  | { type: "prompt"; content: string; maxTurns?: number }
  | { type: "steer"; content: string }
  | { type: "fork"; parentId: string }
  | { type: "close" };

/**
 * SessionListResponse - Response from GET /v1/sessions
 */
export interface SessionListResponse {
  sessions: SessionSummary[];
  total: number;
}

export interface SessionSummary {
  id: string;
  workflowId: string;
  status: SessionState["status"];
  messageCount: number;
  updatedAt: number;
  isActive: boolean;            // workflow is running and waiting
}

export interface Env {
  // API token for authentication
  CLAWFLARE_API_TOKEN: string;

  // Durable Object for strongly consistent agent session state/events
  SESSION_STORE: DurableObjectNamespace;

  // SQLite Durable Object for stored code and egress handlers
  DATASTORE: DurableObjectNamespace;

  // Durable Object for WebSocket workflow session coordination
  WEBSOCKET_SESSION: DurableObjectNamespace;

  // Service binding to the HttpGateway entrypoint for Dynamic Worker egress
  HTTP_GATEWAY: Fetcher;

  // Worker Loader for Dynamic Worker execution
  LOADER: WorkerLoader;

  // Workflow for durable agent execution
  AGENT_WORKFLOW: Workflow;

  // Environment variables
  CLOUDFLARE_API_TOKEN: string;
  CLOUDFLARE_ACCOUNT_ID: string;
  GITHUB_TOKEN?: string;

  AI_PROVIDER: string;
  AI_MODEL?: string;
  MOCK_AI?: string;
  CLAWFLARE_DEBUG_TIMING?: string;
  AWS_BEARER_TOKEN_BEDROCK?: string;
  AWS_REGION?: string;
  AWS_PROFILE?: string;

  // Optional provider API keys for non-default AI providers.
  ANTHROPIC_OAUTH_TOKEN?: string;
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  AZURE_OPENAI_API_KEY?: string;
  DEEPSEEK_API_KEY?: string;
  GEMINI_API_KEY?: string;
  GOOGLE_CLOUD_API_KEY?: string;
  GROQ_API_KEY?: string;
  CEREBRAS_API_KEY?: string;
  XAI_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  AI_GATEWAY_API_KEY?: string;
  ZAI_API_KEY?: string;
  MISTRAL_API_KEY?: string;
  MINIMAX_API_KEY?: string;
  MINIMAX_CN_API_KEY?: string;
  MOONSHOT_API_KEY?: string;
  HF_TOKEN?: string;
  FIREWORKS_API_KEY?: string;
  OPENCODE_API_KEY?: string;
  KIMI_API_KEY?: string;
  CLOUDFLARE_API_KEY?: string;
  XIAOMI_API_KEY?: string;
  XIAOMI_TOKEN_PLAN_CN_API_KEY?: string;
  XIAOMI_TOKEN_PLAN_AMS_API_KEY?: string;
  XIAOMI_TOKEN_PLAN_SGP_API_KEY?: string;
}

// API Request/Response types
export interface ChatRequest {
  type: "prompt" | "steer" | "fork" | "new_context";
  content?: string;
  sessionId?: string;
  maxTurns?: number;
}

export interface ChatResponse {
  type: "message" | "error" | "context_update";
  content: string;
  sessionId?: string;
  messages?: AgentMessage[];
  usage?: Usage;
}

/**
 * SessionResponse - Returned from GET /v1/session/:id
 */
export interface SessionResponse {
  id: string;
  status: "idle" | "processing" | "awaiting_input" | "error" | "closed" | "expired";
  messages: AgentMessage[];
  events: AgentEvent[];
  nextEventCursor: string;
  errorMessage?: string;
}

// Tool definition types
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

// Context for agent
export interface AgentSession {
  id: string;
  parentId?: string;
  messages: AgentMessage[];
  createdAt: number;
}

// Dynamic Worker execution result
export interface ExecutionResult {
  ok: boolean;
  result?: unknown;
  error?: string;
  stdout?: string;
  stderr?: string;
}
