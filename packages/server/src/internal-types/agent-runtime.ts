// Internal agent runtime types - in-memory state during execution
// These types are NOT persisted directly; use AgentSnapshot for persistence

import type {
  AgentMessage,
  AgentTool,
  AgentToolCall,
  AgentToolResult,
  AgentEvent,
  StreamFn,
  ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Message, Model } from "@earendil-works/pi-ai";
import type { QueueMode } from "./session.js";

/**
 * Agent tool call state during execution
 */
export interface AgentToolCallState {
  id: string;
  name: string;
  args: unknown;
  turnId: string;
  status: "pending" | "running" | "complete" | "error";
  result?: AgentToolResult<unknown>;
  isError?: boolean;
}

/**
 * Agent turn state during execution
 */
export interface AgentTurnState {
  id: string;
  index: number;
  status: "awaiting_assistant" | "awaiting_tools" | "complete" | "error";
  assistantMessage?: AssistantMessage;
  toolCallIds: string[];
  toolResultIds: string[];
}

/**
 * Agent runtime state - in-memory during a workflow step
 * WARNING: Do not persist this directly. Use AgentSnapshot for storage.
 */
export interface AgentRuntimeState {
  id: string;
  createdAt: number;
  updatedAt: number;
  systemPrompt: string;
  model: Model<any>;
  thinkingLevel: ThinkingLevel;
  messages: AgentMessage[];
  steeringQueue: AgentMessage[];
  followUpQueue: AgentMessage[];
  steeringMode: QueueMode;
  followUpMode: QueueMode;
  turns: AgentTurnState[];
  toolCalls: Record<string, AgentToolCallState>;
  status: "idle" | "running" | "awaiting_input" | "error";
  errorMessage?: string;
}

/**
 * Agent configuration
 */
export interface AgentConfig {
  model: Model<any>;
  systemPrompt: string;
  tools: AgentTool[];
  streamFn?: StreamFn;
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
  convertToLlm?: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
  debugTiming?: (phase: string, startedAt?: number, details?: Record<string, unknown>) => void;
  onEvent?: (event: AgentEvent) => void | Promise<void>;
}

/**
 * Result of a single agent step
 */
export interface AgentStepResult {
  session: AgentRuntimeState;
  events: AgentEvent[];
}

/**
 * Result of assistant step generation
 */
export interface AssistantStepResult extends AgentStepResult {
  assistantMessage: AssistantMessage;
  toolCalls: AgentToolCallState[];
  shouldExecuteTools: boolean;
}

/**
 * Result of tool execution step
 */
export interface ToolStepResult extends AgentStepResult {
  toolResultMessage: {
    role: "toolResult";
    content: Array<{type: "text"; text: string}>;
  };
}

/**
 * Result of completing a turn
 */
export interface CompleteTurnResult extends AgentStepResult {
  completedTurnIndex: number;
  shouldContinue: boolean;
  shouldStop: boolean;
}

// Workflow step types for decoupled execution
export type StepType = "assistant" | "tool" | "complete" | "finalize";

/**
 * Information about the next step to execute
 */
export interface NextStepInfo {
  type: StepType;
  stepId: string;
  displayName: string;
  toolCallId?: string;
}

/**
 * Result of running a workflow step
 */
export interface RunStepResult extends AgentStepResult {
  session: AgentRuntimeState;
  nextStep?: NextStepInfo;
  shouldContinue: boolean;
  shouldStop: boolean;
}

/**
 * Group of tool calls for a turn
 */
export interface ToolCallGroup {
  turnId: string;
  calls: AgentToolCall[];
}

/**
 * Content item types
 */
export interface TextContent {
  type: "text";
  text: string;
}
