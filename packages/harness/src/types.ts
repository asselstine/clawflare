// Types for the Clawflare Harness
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
export type { AgentMessage } from "@earendil-works/pi-agent-core";

export interface Env {
  // API token for authentication
  CLAWFLARE_API_TOKEN: string;

  // KV namespace for agent conversation state
  AGENT_STATE: KVNamespace;

  // SQLite Durable Object for stored code and egress handlers
  DATASTORE: DurableObjectNamespace;

  // Worker Loader for Dynamic Worker execution
  LOADER: WorkerLoader;

  // Environment variables
  CLOUDFLARE_API_TOKEN: string;
  CLOUDFLARE_ACCOUNT_ID: string;
  GITHUB_TOKEN?: string;

  AI_PROVIDER: string;
  AI_MODEL?: string;
  MOCK_AI?: string;
  AWS_BEARER_TOKEN_BEDROCK?: string;
  AWS_REGION?: string;
  AWS_PROFILE?: string;
}

// API Request/Response types
export interface ChatRequest {
  type: "prompt" | "steer" | "fork" | "new_context";
  content?: string;
  contextId?: string;
}

export interface ChatResponse {
  type: "message" | "error" | "context_update";
  content: string;
  contextId?: string;
  messages?: AgentMessage[];
  usage?: Usage;
}

// Tool definition types
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

// Context for agent
export interface AgentContextData {
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
