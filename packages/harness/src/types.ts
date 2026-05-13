// Types for the Clawflare Harness
import type { AgentMessage } from "@earendil-works/pi-agent-core";
export type { AgentMessage } from "@earendil-works/pi-agent-core";

export interface Env {
  // API token for authentication
  CLAWFLARE_API_TOKEN: string;

  // KV namespaces
  SKILLS: KVNamespace;
  AGENT_STATE: KVNamespace;

  // Durable Object
  AGENT_DO: DurableObjectNamespace;

  // Environment variables
  CLOUDFLARE_API_TOKEN: string;
  CLOUDFLARE_ACCOUNT_ID: string;
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
}

// Tool definition types
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

// Skill stored in KV
export interface Skill {
  id: string;
  name: string;
  content: string;
  createdAt: number;
  updatedAt: number;
}

// Context for agent
export interface AgentContextData {
  id: string;
  parentId?: string;
  messages: AgentMessage[];
  skills: string[];
  createdAt: number;
}