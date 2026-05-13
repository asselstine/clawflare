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

  // Workflow for durable agent execution
  AGENT_WORKFLOW: Workflow;

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
