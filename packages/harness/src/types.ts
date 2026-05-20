// Public types exported for clients
// These types can be imported by non-Workers environments (CLI, etc.)

import type { AgentMessage, AgentEvent } from "@earendil-works/pi-agent-core";

// Re-export AgentMessage so clients don't need pi-agent-core directly
export type { AgentMessage } from "@earendil-works/pi-agent-core";

/**
 * SessionEvent - AgentEvent with timestamp and per-session sequence added by server.
 */
export type SessionEvent = AgentEvent & { timestamp: number; sequence: number };

/**
 * Session status values
 */
export type SessionStatus =
  | "idle"
  | "processing"
  | "awaiting_input"
  | "error"
  | "closed"
  | "expired";

/**
 * SessionState - The current state of an agent session
 * Client polls this to get message history and processing events
 */
export interface SessionState {
  id: string;
  workflowId: string;
  status: SessionStatus;
  messages: AgentMessage[];
  nextEventCursor: string;
  updatedAt: number;
  errorMessage?: string;
}

/**
 * ChatSubmittedResponse - Returned immediately from POST /v1/chat
 */
export interface ChatSubmittedResponse {
  sessionId: string;
  eventCursor: string;
  isNewSession: boolean;
}

/**
 * SessionSummary - Summary of a session for list views
 */
export interface SessionSummary {
  id: string;
  workflowId: string;
  status: SessionStatus;
  messageCount: number;
  updatedAt: number;
  isActive: boolean;
}

/**
 * SessionListResponse - Response from GET /v1/sessions
 */
export interface SessionListResponse {
  sessions: SessionSummary[];
  total: number;
}

/**
 * ChatRequest - Request body for POST /v1/chat
 */
export interface ChatRequest {
  type: "prompt" | "steer" | "fork" | "new_context";
  content?: string;
  sessionId?: string;
  maxTurns?: number;
}

/**
 * SessionResponse - Returned from GET /v1/session/:id
 */
export interface SessionResponse {
  id: string;
  status: SessionStatus;
  messages: AgentMessage[];
  events: SessionEvent[];
  nextEventCursor: string;
  errorMessage?: string;
}

/**
 * AgentSession - Context for agent
 */
export interface AgentSession {
  id: string;
  parentId?: string;
  messages: AgentMessage[];
  createdAt: number;
}

/**
 * Tool definition for listing available tools
 */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}
