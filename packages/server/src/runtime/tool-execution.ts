import type { AgentToolCall, AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import { validateToolArguments } from "@earendil-works/pi-ai";
import type { MarkToolRunRunningParams, MarkToolRunTerminalParams, ToolRun } from "../data/index.js";
import type { RuntimeTool, ToolRuntimeContext } from "../modules/tools/types.js";

export type ToolRunStatus = "running" | "complete" | "error" | "aborted";

const DEFAULT_TOOL_EXECUTION_TIMEOUT_MS = 65_000;
const TOOL_EXECUTION_TIMEOUT_BUFFER_MS = 5_000;

export interface ToolRunCall {
  id: string;
  name: string;
  args: unknown;
}

export interface ToolRunStepResult {
  toolCallId: string;
  toolName: string;
  status: ToolRunStatus;
  isError: boolean;
  result: AgentToolResult<unknown>;
}

export interface ToolExecutionServiceConfig {
  tools: RuntimeTool[];
  toolRuntimeContext: ToolRuntimeContext;
  toolExecutionTimeoutMs?: number;
  toolRuns?: DurableToolRunStore;
  onTerminalToolRun?: (sessionId: string, toolCallId: string) => void | Promise<void>;
  debugTiming?: (phase: string, startedAt?: number, details?: Record<string, unknown>) => void;
}

export interface DurableToolRunStore {
  findByToolCall(sessionId: string, toolCallId: string): Promise<ToolRun | null>;
  markRunning(params: MarkToolRunRunningParams): Promise<ToolRun>;
  markTerminal(params: MarkToolRunTerminalParams): Promise<ToolRun>;
}

function now(): number {
  return Date.now();
}

function createErrorToolResult(
  message: string,
  details: Record<string, unknown> = {},
): AgentToolResult<unknown> {
  return {
    content: [{ type: "text", text: message }],
    details,
  };
}

function isErroredToolResult(result: AgentToolResult<unknown>): boolean {
  const details = result.details;
  return typeof details === "object" && details !== null && "ok" in details && details.ok === false;
}

function isAbortedToolResult(result: AgentToolResult<unknown>): boolean {
  const details = result.details;
  if (typeof details !== "object" || details === null) return false;
  return (details as Record<string, unknown>).aborted === true ||
    (details as Record<string, unknown>).stopped === true;
}

function isPendingToolResult(result: AgentToolResult<unknown>): boolean {
  const details = result.details;
  return typeof details === "object" && details !== null && "pending" in details && details.pending === true;
}

function pendingToolRunState(result: AgentToolResult<unknown>): unknown {
  const details = result.details;
  if (typeof details !== "object" || details === null || !("toolRunState" in details)) return undefined;
  return (details as { toolRunState?: unknown }).toolRunState;
}

function requestedToolExecutionTimeoutMs(params: unknown): number | undefined {
  if (typeof params !== "object" || params === null || Array.isArray(params)) return undefined;
  const timeoutMs = (params as Record<string, unknown>).timeoutMs;
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs)) return undefined;
  return Math.max(1, Math.floor(timeoutMs) + TOOL_EXECUTION_TIMEOUT_BUFFER_MS);
}

function effectiveToolExecutionTimeoutMs(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined) return DEFAULT_TOOL_EXECUTION_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs)) return DEFAULT_TOOL_EXECUTION_TIMEOUT_MS;
  return Math.max(1, Math.floor(timeoutMs));
}

function toolAbortError(): Error {
  const error = new Error("Tool execution aborted.");
  error.name = "AbortError";
  return error;
}

async function runWithToolTimeout<T>(
  timeoutMs: number | undefined,
  signal: AbortSignal | undefined,
  callback: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const timeout = effectiveToolExecutionTimeoutMs(timeoutMs);
  if (signal?.aborted) throw toolAbortError();

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let finished = false;

  const cleanup = () => {
    if (finished) return;
    finished = true;
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    signal?.removeEventListener("abort", onAbort);
  };

  const toolPromise = Promise.resolve().then(() => callback(controller.signal));
  toolPromise.catch(() => undefined);

  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(new Error(`Tool execution timed out after ${timeout}ms.`));
    }, timeout);
  });

  const abortPromise = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener("abort", () => {
      if (signal?.aborted) reject(toolAbortError());
    }, { once: true });
  });

  try {
    return await Promise.race([toolPromise, timeoutPromise, abortPromise]);
  } finally {
    cleanup();
  }
}

function toolRuntimeSession(context: ToolRuntimeContext): { sessionId: string; workspaceId?: string } {
  return {
    sessionId: context.sessionId,
    workspaceId: context.workspaceId,
  };
}

function isTerminalToolRun(run: ToolRun | null): run is ToolRun & {
  status: "complete" | "error" | "aborted";
  result: AgentToolResult<unknown>;
} {
  return Boolean(
    run &&
      run.status !== "running" &&
      run.result !== undefined &&
      typeof run.result === "object" &&
      run.result !== null &&
      "content" in run.result,
  );
}

export class ToolExecutionService {
  private readonly toolsByName: Map<string, RuntimeTool>;

  constructor(private readonly config: ToolExecutionServiceConfig) {
    this.toolsByName = new Map(config.tools.map((tool) => [tool.name, tool]));
  }

  async runOrResume(
    toolCall: ToolRunCall,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback,
  ): Promise<ToolRunStepResult> {
    const tool = this.toolsByName.get(toolCall.name);
    const toolStepStart = now();
    this.config.debugTiming?.("tool.start", undefined, {
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      hasTool: Boolean(tool),
    });

    const storedRun = await this.findStoredToolRun(toolCall);
    if (isTerminalToolRun(storedRun)) {
      const status = storedRun.status;
      return {
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        status,
        isError: status === "error" || status === "aborted",
        result: storedRun.result,
      };
    }

    let result: AgentToolResult<unknown>;

    if (!tool) {
      result = createErrorToolResult(`Tool ${toolCall.name} not found`, { ok: false });
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
        const toolRunState = storedRun?.status === "running" ? storedRun.internalState : undefined;
        this.config.debugTiming?.("tool.args.validated", argsStart, {
          toolCallId: toolCall.id,
          toolName: toolCall.name,
        });
        await this.markToolRunRunning(toolCall, validatedArgs, toolRunState);

        const executeStart = now();
        result = await runWithToolTimeout(
          this.config.toolExecutionTimeoutMs ?? requestedToolExecutionTimeoutMs(validatedArgs),
          signal,
          (toolSignal) => tool.execute(
            this.config.toolRuntimeContext,
            toolCall.id,
            validatedArgs as never,
            toolSignal,
            onUpdate,
            toolRunState,
          ),
        );
        this.config.debugTiming?.("tool.execute.done", executeStart, {
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          contentLength: JSON.stringify(result.content).length,
        });
      } catch (error) {
        const aborted = error instanceof Error && error.name === "AbortError";
        result = createErrorToolResult(error instanceof Error ? error.message : String(error), {
          ok: false,
          ...(aborted ? { aborted: true, reason: "abort_signal" } : {}),
        });
        this.config.debugTiming?.("tool.execute.error", toolStepStart, {
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const status = this.statusFromResult(result);
    const isError = status === "error" || status === "aborted";
    await this.persistToolRunOutcome(toolCall, status, result);
    this.config.debugTiming?.("tool.done", toolStepStart, {
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      status,
      isError,
    });

    return {
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      status,
      isError,
      result,
    };
  }

  private async markToolRunRunning(
    toolCall: ToolRunCall,
    input: unknown,
    internalState?: unknown,
    partialResult?: AgentToolResult<unknown>,
  ): Promise<void> {
    const toolRuns = this.config.toolRuns;
    if (!toolRuns) return;
    const { sessionId, workspaceId } = toolRuntimeSession(this.config.toolRuntimeContext);
    await toolRuns.markRunning({
      sessionId,
      workspaceId,
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      input,
      internalState,
      partialResult,
    });
  }

  private async persistToolRunOutcome(
    toolCall: ToolRunCall,
    status: ToolRunStatus,
    result: AgentToolResult<unknown>,
  ): Promise<void> {
    const toolRuns = this.config.toolRuns;
    if (!toolRuns) return;
    const internalState = status === "running" ? pendingToolRunState(result) : undefined;
    if (status === "running") {
      await this.markToolRunRunning(toolCall, toolCall.args, internalState, result);
      return;
    }
    const { sessionId, workspaceId } = toolRuntimeSession(this.config.toolRuntimeContext);
    await toolRuns.markTerminal({
      sessionId,
      workspaceId,
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      input: toolCall.args,
      internalState: undefined,
      status,
      result,
    });
    await this.config.onTerminalToolRun?.(sessionId, toolCall.id);
  }

  private async findStoredToolRun(toolCall: ToolRunCall): Promise<ToolRun | null> {
    const toolRuns = this.config.toolRuns;
    if (!toolRuns) return null;
    const { sessionId } = toolRuntimeSession(this.config.toolRuntimeContext);
    return toolRuns.findByToolCall(sessionId, toolCall.id);
  }

  private statusFromResult(result: AgentToolResult<unknown>): ToolRunStatus {
    if (isPendingToolResult(result)) return "running";
    if (isAbortedToolResult(result)) return "aborted";
    if (isErroredToolResult(result)) return "error";
    return "complete";
  }
}
