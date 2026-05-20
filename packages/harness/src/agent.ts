// Simplified agent runtime
import type { AgentMessage, AgentEvent, AgentTool } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Model, Message as AiMessage } from "@earendil-works/pi-ai";

export type QueueMode = "all" | "one-at-a-time";

export interface AgentToolCallState {
  id: string;
  name: string;
  args: unknown;
  turnId: string;
  status: "pending" | "running" | "complete" | "error";
  result?: unknown;
  isError?: boolean;
}

export interface AgentTurnState {
  id: string;
  index: number;
  status: "awaiting_assistant" | "awaiting_tools" | "complete" | "error";
  assistantMessage?: AssistantMessage;
  toolCallIds: string[];
  toolResultIds: string[];
}

export interface AgentRuntimeState {
  id: string;
  createdAt: number;
  updatedAt: number;
  systemPrompt: string;
  model: Model<any>;
  thinkingLevel: string;
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

export interface AgentConfig {
  model: Model<any>;
  systemPrompt: string;
  tools: AgentTool[];
  convertToLlm?: (messages: AgentMessage[]) => AiMessage[];
  onEvent?: (event: AgentEvent) => void | Promise<void>;
}

export function createEmptyAgentSession(args: {
  sessionId: string;
  systemPrompt: string;
  model: Model<any>;
  thinkingLevel?: string;
  messages?: AgentMessage[];
}): AgentRuntimeState {
  const timestamp = Date.now();
  return {
    id: args.sessionId,
    createdAt: timestamp,
    updatedAt: timestamp,
    systemPrompt: args.systemPrompt,
    model: args.model,
    thinkingLevel: args.thinkingLevel ?? "none",
    messages: args.messages ?? [],
    steeringQueue: [],
    followUpQueue: [],
    steeringMode: "one-at-a-time",
    followUpMode: "one-at-a-time",
    turns: [],
    toolCalls: {},
    status: "idle",
  };
}

// For backward compatibility
export type AgentSessionState = AgentRuntimeState;

// Additional types needed by external code
export type StepType = "assistant" | "tool" | "complete" | "finalize";

export interface NextStepInfo {
  type: StepType;
  stepId: string;
  displayName: string;
  toolCallId?: string;
}

export function determineNextStep(_session: AgentRuntimeState): NextStepInfo | null {
  // Simplified - return assistant step
  return {
    type: "assistant",
    stepId: `step_${Date.now()}`,
    displayName: "Assistant",
  };
}

export async function runStep(
  _session: AgentRuntimeState,
  _stepInfo: NextStepInfo,
  _config: AgentConfig
): Promise<{
  session: AgentRuntimeState;
  events: AgentEvent[];
  nextStep?: NextStepInfo;
  shouldContinue: boolean;
  shouldStop: boolean;
}> {
  // Placeholder - would actual execute a step
  return {
    session: _session,
    events: [],
    shouldContinue: false,
    shouldStop: true,
  };
}
