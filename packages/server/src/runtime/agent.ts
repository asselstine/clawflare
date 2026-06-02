import type {
  AgentEvent,
  AgentMessage,
  AgentTool,
  AgentToolCall,
  AgentToolResult,
  StreamFn,
  ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Context, Message, Model, ToolResultMessage } from "@earendil-works/pi-ai";
import { streamSimple, validateToolArguments } from "@earendil-works/pi-ai";

export type QueueMode = "all" | "one-at-a-time";

export interface AgentToolCallState {
  id: string;
  name: string;
  args: unknown;
  turnId: string;
  status: "pending" | "running" | "complete" | "error";
  result?: AgentToolResult<unknown>;
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

export interface AgentSessionState {
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

export interface AgentStepResult {
  session: AgentSessionState;
  events: AgentEvent[];
}

export interface AssistantStepResult extends AgentStepResult {
  assistantMessage: AssistantMessage;
  toolCalls: AgentToolCallState[];
  shouldExecuteTools: boolean;
}

export interface ToolStepResult extends AgentStepResult {
  toolResultMessage: ToolResultMessage;
}

export interface CompleteTurnResult extends AgentStepResult {
  completedTurnIndex: number;
  shouldContinue: boolean;
  shouldStop: boolean;
}

// Workflow step types for decoupled execution
export type StepType = "assistant" | "tool" | "complete" | "finalize";

export interface NextStepInfo {
  type: StepType;
  stepId: string;
  displayName: string;
  toolCallId?: string;
}

export interface RunStepResult extends AgentStepResult {
  session: AgentSessionState;
  nextStep?: NextStepInfo;
  shouldContinue: boolean;
  shouldStop: boolean;
}

function defaultConvertToLlm(messages: AgentMessage[]): Message[] {
  return messages.filter(
    (message): message is Message =>
      message.role === "user" || message.role === "assistant" || message.role === "toolResult",
  );
}

function now(): number {
  return Date.now();
}

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

function textMessage(text: string): AgentMessage {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp: now(),
  } as AgentMessage;
}

function extractToolCalls(message: AssistantMessage): AgentToolCall[] {
  if (!Array.isArray(message.content)) return [];
  return message.content.filter((item): item is AgentToolCall => item.type === "toolCall");
}

function createErrorToolResult(message: string): AgentToolResult<unknown> {
  return {
    content: [{ type: "text", text: message }],
    details: {},
  };
}

function isErroredToolResult(result: AgentToolResult<unknown>): boolean {
  const details = result.details;
  return typeof details === "object" && details !== null && "ok" in details && details.ok === false;
}

function createToolResultMessage(
  toolCall: AgentToolCallState,
  result: AgentToolResult<unknown>,
  isError: boolean,
): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    content: result.content,
    details: result.details,
    isError,
    timestamp: now(),
  };
}

function latestTurn(session: AgentSessionState): AgentTurnState | undefined {
  return session.turns.at(-1);
}

function unsatisfiedToolCalls(session: AgentSessionState): AgentToolCallState[] {
  const turn = latestTurn(session);
  if (!turn) return [];
  return turn.toolCallIds
    .map((id) => session.toolCalls[id])
    .filter((toolCall): toolCall is AgentToolCallState => Boolean(toolCall))
    .filter((toolCall) => toolCall.status === "pending" || toolCall.status === "running");
}

function drainQueue(queue: AgentMessage[], mode: QueueMode): {
  drained: AgentMessage[];
  remaining: AgentMessage[];
} {
  if (queue.length === 0) return { drained: [], remaining: [] };
  if (mode === "all") return { drained: queue, remaining: [] };
  return { drained: [queue[0]!], remaining: queue.slice(1) };
}

function nextTurnIndex(session: AgentSessionState): number {
  return (session.turns.at(-1)?.index ?? 0) + 1;
}

function createEmptyTurn(index: number): AgentTurnState {
  return {
    id: newId("turn"),
    index,
    status: "awaiting_assistant",
    toolCallIds: [],
    toolResultIds: [],
  };
}

export function createEmptyAgentSession(args: {
  sessionId: string;
  systemPrompt: string;
  model: Model<any>;
  thinkingLevel?: ThinkingLevel;
  messages?: AgentMessage[];
}): AgentSessionState {
  const timestamp = now();
  return {
    id: args.sessionId,
    createdAt: timestamp,
    updatedAt: timestamp,
    systemPrompt: args.systemPrompt,
    model: args.model,
    thinkingLevel: args.thinkingLevel ?? "off",
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

export class Agent {
  private readonly toolsByName: Map<string, AgentTool>;
  private readonly streamFn: StreamFn;
  private readonly convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;

  constructor(private readonly config: AgentConfig) {
    this.toolsByName = new Map(config.tools.map((tool) => [tool.name, tool]));
    this.streamFn = config.streamFn ?? streamSimple;
    this.convertToLlm = config.convertToLlm ?? defaultConvertToLlm;
  }

  static completeTurn(session: AgentSessionState): CompleteTurnResult {
    const turn = latestTurn(session);
    if (!turn) throw new Error("Cannot complete turn without active turn");

    const remainingToolCalls = unsatisfiedToolCalls(session);
    if (remainingToolCalls.length > 0) {
      return {
        session,
        events: [],
        completedTurnIndex: turn.index,
        shouldContinue: false,
        shouldStop: false,
      };
    }

    const toolResults = session.messages.filter(
      (message): message is ToolResultMessage =>
        message.role === "toolResult" && turn.toolCallIds.includes(message.toolCallId),
    );

    const events: AgentEvent[] = [
      {
        type: "turn_end",
        message: turn.assistantMessage ?? session.messages.at(-1)!,
        toolResults,
      },
    ];

    let nextSession: AgentSessionState = {
      ...session,
      updatedAt: now(),
      turns: session.turns.map((candidate) =>
        candidate.id === turn.id
          ? { ...turn, status: turn.status === "error" ? "error" : "complete" }
          : candidate,
      ),
    };

    if (turn.status === "error" || nextSession.status === "error") {
      return {
        session: nextSession,
        events,
        completedTurnIndex: turn.index,
        shouldContinue: false,
        shouldStop: true,
      };
    }

    if (toolResults.length > 0) {
      nextSession = {
        ...nextSession,
        turns: [...nextSession.turns, createEmptyTurn(turn.index + 1)],
      };
      return {
        session: nextSession,
        events,
        completedTurnIndex: turn.index,
        shouldContinue: true,
        shouldStop: false,
      };
    }

    const steering = drainQueue(nextSession.steeringQueue, nextSession.steeringMode);
    if (steering.drained.length > 0) {
      nextSession = {
        ...nextSession,
        messages: [...nextSession.messages, ...steering.drained],
        steeringQueue: steering.remaining,
        turns: [...nextSession.turns, createEmptyTurn(turn.index + 1)],
      };
      return {
        session: nextSession,
        events,
        completedTurnIndex: turn.index,
        shouldContinue: true,
        shouldStop: false,
      };
    }

    const followUp = drainQueue(nextSession.followUpQueue, nextSession.followUpMode);
    if (followUp.drained.length > 0) {
      nextSession = {
        ...nextSession,
        messages: [...nextSession.messages, ...followUp.drained],
        followUpQueue: followUp.remaining,
        turns: [...nextSession.turns, createEmptyTurn(turn.index + 1)],
      };
      return {
        session: nextSession,
        events,
        completedTurnIndex: turn.index,
        shouldContinue: true,
        shouldStop: false,
      };
    }

    events.push({ type: "agent_end", messages: [] });
    nextSession = { ...nextSession, status: "idle" };

    return {
      session: nextSession,
      events,
      completedTurnIndex: turn.index,
      shouldContinue: false,
      shouldStop: true,
    };
  }

  static determineNextStep(session: AgentSessionState): NextStepInfo | undefined {
    // Only actively running sessions have workflow work to do.
    if (session.status !== "running") {
      return undefined;
    }

    // Check for pending tool calls first
    const pending = unsatisfiedToolCalls(session);
    if (pending.length > 0) {
      const toolCall = pending[0]!;
      return {
        type: "tool",
        stepId: `tool-${toolCall.id}`,
        displayName: `Running ${toolCall.name}`,
        toolCallId: toolCall.id,
      };
    }

    const turn = latestTurn(session);
    if (!turn) {
      // No turn yet - need assistant step
      return {
        type: "assistant",
        stepId: "assistant",
        displayName: "Assistant response",
      };
    }

    // Handle turn states
    if (turn.status === "awaiting_assistant") {
      return {
        type: "assistant",
        stepId: `turn-${turn.index}-assistant`,
        displayName: `Turn ${turn.index}: Assistant`,
      };
    }

    if (turn.status === "awaiting_tools") {
      return {
        type: "complete",
        stepId: `turn-${turn.index}-complete`,
        displayName: `Turn ${turn.index}: Complete`,
      };
    }

    if (turn.status === "complete") {
      return {
        type: "complete",
        stepId: `turn-${turn.index}-complete`,
        displayName: `Turn ${turn.index}: Complete`,
      };
    }

    return undefined;
  }

  enqueuePrompt(session: AgentSessionState, prompt: string | AgentMessage): AgentStepResult {
    const message = typeof prompt === "string" ? textMessage(prompt) : prompt;
    const turn = createEmptyTurn(nextTurnIndex(session));
    const events: AgentEvent[] = [
      { type: "agent_start" },
      { type: "turn_start" },
      { type: "message_start", message },
      { type: "message_end", message },
    ];

    return {
      session: {
        ...session,
        status: "running",
        updatedAt: now(),
        messages: [...session.messages, message],
        turns: [...session.turns, turn],
      },
      events,
    };
  }

  enqueueSteering(session: AgentSessionState, message: string | AgentMessage): AgentSessionState {
    return {
      ...session,
      updatedAt: now(),
      steeringQueue: [...session.steeringQueue, typeof message === "string" ? textMessage(message) : message],
    };
  }

  enqueueFollowUp(session: AgentSessionState, message: string | AgentMessage): AgentSessionState {
    return {
      ...session,
      updatedAt: now(),
      followUpQueue: [...session.followUpQueue, typeof message === "string" ? textMessage(message) : message],
    };
  }

  async runAssistantStep(session: AgentSessionState, signal?: AbortSignal): Promise<AssistantStepResult> {
    const turn = latestTurn(session);
    if (!turn) throw new Error("Cannot run assistant step without an active turn");
    if (turn.status !== "awaiting_assistant") {
      throw new Error(`Turn ${turn.id} is not awaiting an assistant response`);
    }

    const assistantStepStart = now();
    let contextMessages = session.messages;

    const convertStart = now();
    const llmContext: Context = {
      systemPrompt: session.systemPrompt,
      messages: await this.convertToLlm(contextMessages),
      tools: this.config.tools,
    };
    this.config.debugTiming?.("assistant.context.prepared", convertStart, {
      agentMessageCount: contextMessages.length,
      llmMessageCount: llmContext.messages.length,
      toolCount: this.config.tools.length,
    });

    const apiKeyStart = now();
    const apiKey = this.config.getApiKey
      ? await this.config.getApiKey(session.model.provider)
      : undefined;
    this.config.debugTiming?.("assistant.api_key.resolved", apiKeyStart, {
      provider: session.model.provider,
      hasApiKey: Boolean(apiKey),
    });

    const streamCreateStart = now();
    const streamOptions = {
      apiKey: apiKey ?? undefined,
      signal,
      reasoning: session.thinkingLevel === "off" ? undefined : session.thinkingLevel,
      ...(session.model.provider === "amazon-bedrock" && apiKey ? { bearerToken: apiKey } : {}),
    };
    this.config.debugTiming?.("assistant.stream.create.start", undefined, {
      model: session.model.id,
      provider: session.model.provider,
      reasoning: streamOptions.reasoning,
    });
    const response = await this.streamFn(session.model, llmContext, streamOptions);
    this.config.debugTiming?.("assistant.stream.created", streamCreateStart, {
      model: session.model.id,
      provider: session.model.provider,
    });

    const events: AgentEvent[] = [];
    let finalMessage: AssistantMessage | undefined;
    let sawFirstStreamEvent = false;

    for await (const event of response) {
      if (!sawFirstStreamEvent) {
        sawFirstStreamEvent = true;
        this.config.debugTiming?.("assistant.stream.first_event", streamCreateStart, {
          eventType: event.type,
          assistantStepElapsedMs: Date.now() - assistantStepStart,
        });
      }
      if (event.type === "start") {
        const agentEvent: AgentEvent = { type: "message_start", message: { ...event.partial } };
        events.push(agentEvent);
        await this.config.onEvent?.(agentEvent);
        continue;
      }

      if (event.type === "done" || event.type === "error") {
        finalMessage = await response.result();
        break;
      }

      const agentEvent: AgentEvent = {
        type: "message_update",
        message: { ...event.partial },
        assistantMessageEvent: event,
      };
      events.push(agentEvent);
      await this.config.onEvent?.(agentEvent);
    }

    const resultStart = now();
    finalMessage ??= await response.result();
    this.config.debugTiming?.("assistant.stream.result", resultStart, {
      totalAssistantStepElapsedMs: Date.now() - assistantStepStart,
      stopReason: finalMessage.stopReason,
      outputLength: JSON.stringify(finalMessage.content).length,
    });
    const messageEndEvent: AgentEvent = { type: "message_end", message: finalMessage };
    events.push(messageEndEvent);
    await this.config.onEvent?.(messageEndEvent);

    const toolCalls = extractToolCalls(finalMessage);
    const agentToolCalls: AgentToolCallState[] = toolCalls.map((toolCall) => ({
      id: toolCall.id,
      name: toolCall.name,
      args: toolCall.arguments,
      turnId: turn.id,
      status: "pending",
    }));

    const nextToolCalls = { ...session.toolCalls };
    for (const toolCall of agentToolCalls) {
      nextToolCalls[toolCall.id] = toolCall;
    }

    const isError = finalMessage.stopReason === "error" || finalMessage.stopReason === "aborted";
    const nextTurn: AgentTurnState = {
      ...turn,
      status: isError ? "error" : toolCalls.length > 0 ? "awaiting_tools" : "complete",
      assistantMessage: finalMessage,
      toolCallIds: agentToolCalls.map((toolCall) => toolCall.id),
    };

    const nextSession: AgentSessionState = {
      ...session,
      updatedAt: now(),
      messages: [...session.messages, finalMessage],
      turns: session.turns.map((candidate) => (candidate.id === turn.id ? nextTurn : candidate)),
      toolCalls: nextToolCalls,
      status: isError ? "error" : "running",
      errorMessage: finalMessage.errorMessage,
    };

    return {
      session: nextSession,
      events,
      assistantMessage: finalMessage,
      toolCalls: agentToolCalls,
      shouldExecuteTools: agentToolCalls.length > 0,
    };
  }

  async runToolStep(
    session: AgentSessionState,
    toolCallId: string,
    signal?: AbortSignal,
  ): Promise<ToolStepResult> {
    const toolCall = session.toolCalls[toolCallId];
    if (!toolCall) throw new Error(`Unknown tool call: ${toolCallId}`);
    if (toolCall.status === "complete" || toolCall.status === "error") {
      const existing = session.messages.find(
        (message): message is ToolResultMessage =>
          message.role === "toolResult" && message.toolCallId === toolCallId,
      );
      if (existing) return { session, events: [], toolResultMessage: existing };
      throw new Error(`Tool call ${toolCallId} is already finalized without a result message`);
    }

    const events: AgentEvent[] = [];
    const pendingEventAppends: Promise<void>[] = [];
    const tool = this.toolsByName.get(toolCall.name);
    const toolStepStart = now();
    this.config.debugTiming?.("tool.start", undefined, {
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      hasTool: Boolean(tool),
    });
    events.push({
      type: "tool_execution_start",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      args: toolCall.args,
    });
    await this.config.onEvent?.(events[events.length - 1]!);

    let result: AgentToolResult<unknown>;
    let isError = false;

    if (!tool) {
      result = createErrorToolResult(`Tool ${toolCall.name} not found`);
      isError = true;
    } else {
      try {
        const argsStart = now();
        const preparedArgs = tool.prepareArguments ? tool.prepareArguments(toolCall.args) : toolCall.args;
        const validatedArgs = validateToolArguments(tool, {
          id: toolCall.id,
          name: toolCall.name,
          arguments: preparedArgs,
          type: "toolCall",
        } as AgentToolCall);
        this.config.debugTiming?.("tool.args.validated", argsStart, {
          toolCallId: toolCall.id,
          toolName: toolCall.name,
        });

        const executeStart = now();
        result = await tool.execute(toolCall.id, validatedArgs as never, signal, (partialResult) => {
          const event: AgentEvent = {
            type: "tool_execution_update",
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            args: toolCall.args,
            partialResult,
          };
          events.push(event);
          const append = this.config.onEvent?.(event);
          if (append) pendingEventAppends.push(Promise.resolve(append));
        });
        isError = isErroredToolResult(result);
        this.config.debugTiming?.("tool.execute.done", executeStart, {
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          contentLength: JSON.stringify(result.content).length,
        });
      } catch (error) {
        result = createErrorToolResult(error instanceof Error ? error.message : String(error));
        isError = true;
        this.config.debugTiming?.("tool.execute.error", toolStepStart, {
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    this.config.debugTiming?.("tool.done", toolStepStart, {
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      isError,
    });
    if (pendingEventAppends.length > 0) {
      await Promise.all(pendingEventAppends);
    }

    events.push({
      type: "tool_execution_end",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      result,
      isError,
    });
    await this.config.onEvent?.(events[events.length - 1]!);

    const toolResultMessage = createToolResultMessage(toolCall, result, isError);
    const messageStartEvent: AgentEvent = { type: "message_start", message: toolResultMessage };
    events.push(messageStartEvent);
    await this.config.onEvent?.(messageStartEvent);
    const messageEndEvent: AgentEvent = { type: "message_end", message: toolResultMessage };
    events.push(messageEndEvent);
    await this.config.onEvent?.(messageEndEvent);

    const turn = latestTurn(session);
    const nextTurn = turn
      ? {
          ...turn,
          toolResultIds: [...turn.toolResultIds, toolResultMessage.toolCallId],
        }
      : undefined;

    const nextSession: AgentSessionState = {
      ...session,
      updatedAt: now(),
      messages: [...session.messages, toolResultMessage],
      toolCalls: {
        ...session.toolCalls,
        [toolCall.id]: {
          ...toolCall,
          status: isError ? "error" : "complete",
          isError,
        },
      },
      turns: nextTurn
        ? session.turns.map((candidate) => (candidate.id === nextTurn.id ? nextTurn : candidate))
        : session.turns,
    };

    return { session: nextSession, events, toolResultMessage };
  }

  completeTurn(session: AgentSessionState): CompleteTurnResult {
    return Agent.completeTurn(session);
  }

  pendingToolCalls(session: AgentSessionState): AgentToolCallState[] {
    return unsatisfiedToolCalls(session);
  }

  /**
   * Determine what step should run next based on current session state.
   * Returns undefined if the agent is done (idle or error state).
   */
  determineNextStep(session: AgentSessionState): NextStepInfo | undefined {
    return Agent.determineNextStep(session);
  }

  /**
   * Run a single atomic step based on the provided step info.
   * This is the core method for workflow-driven execution.
   */
  async runSingleStep(
    session: AgentSessionState,
    stepInfo: NextStepInfo,
    signal?: AbortSignal,
  ): Promise<RunStepResult> {
    let result: AgentStepResult;

    switch (stepInfo.type) {
      case "assistant": {
        const assistantResult = await this.runAssistantStep(session, signal);
        result = {
          session: assistantResult.session,
          events: assistantResult.events,
        };
        break;
      }
      case "tool": {
        if (!stepInfo.toolCallId) {
          throw new Error("toolCallId required for tool step");
        }
        const toolResult = await this.runToolStep(session, stepInfo.toolCallId, signal);
        result = {
          session: toolResult.session,
          events: toolResult.events,
        };
        break;
      }
      case "complete": {
        const completeResult = this.completeTurn(session);
        result = {
          session: completeResult.session,
          events: completeResult.events,
        };
        break;
      }
      default:
        throw new Error(`Unknown step type: ${stepInfo.type}`);
    }

    const nextStep = this.determineNextStep(result.session);

    return {
      ...result,
      shouldContinue: Boolean(nextStep) && result.session.status !== "error",
      shouldStop: !nextStep || result.session.status === "error",
      nextStep,
    };
  }
}
