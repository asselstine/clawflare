import { describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream, type AssistantMessage, type Context, type Model } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { Agent, createEmptyAgentSession, defaultConvertToLlm } from "../src/runtime/agent.js";
import type { RuntimeTool, ToolRuntimeContext } from "../src/modules/tools/types.js";

describe("Agent", () => {
  const model = {
    id: "test-model",
    provider: "test-provider",
    api: "openai-chat-completions",
    maxTokens: 4096,
  } as Model<any>;
  const toolRuntimeContext = {
    kind: "builtin",
    env: {},
    sessionId: "session-test",
    workspaceId: "workspace-test",
  } as ToolRuntimeContext;

  it("drops orphaned tool results before sending history to the model", () => {
    const converted = defaultConvertToLlm([
      {
        role: "user",
        content: [{ type: "text", text: "start" }],
        timestamp: 1,
      },
      {
        role: "assistant",
        content: [{
          type: "toolCall",
          id: "tool-current",
          name: "container_bash",
          arguments: {},
        }],
        api: "bedrock-converse-stream",
        provider: "amazon-bedrock",
        model: "test-model",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "toolUse",
        timestamp: 2,
      },
      {
        role: "toolResult",
        toolCallId: "tool-current",
        toolName: "container_bash",
        content: [{ type: "text", text: "stopped" }],
        isError: true,
        timestamp: 3,
      },
      {
        role: "toolResult",
        toolCallId: "tool-old",
        toolName: "container_bash",
        content: [{ type: "text", text: "orphaned" }],
        isError: true,
        timestamp: 4,
      },
      {
        role: "user",
        content: [{ type: "text", text: "hello" }],
        timestamp: 5,
      },
    ]);

    expect(converted.map((message) => message.role)).toEqual(["user", "assistant", "toolResult", "user"]);
    expect(converted.filter((message) => message.role === "toolResult").map((message) => message.toolCallId))
      .toEqual(["tool-current"]);
  });

  it("emits tool start through onEvent before the tool finishes", async () => {
    let finishTool!: () => void;
    const toolFinished = new Promise<void>((resolve) => {
      finishTool = resolve;
    });

    const emitted: string[] = [];
    const tool = {
      ref: "code.execute_code",
      groupId: "code",
      name: "execute_code",
      label: "Execute Code",
      description: "Execute code",
      parameters: Type.Object({}),
      execute: async () => {
        await toolFinished;
        return {
          content: [{ type: "text", text: "ok" }],
          details: { ok: true },
        };
      },
    } satisfies RuntimeTool;

    const agent = new Agent({
      model,
      systemPrompt: "",
      tools: [tool],
      toolRuntimeContext,
      onEvent: (event) => {
        emitted.push(event.type);
      },
    });
    const empty = createEmptyAgentSession({ sessionId: "session-test", systemPrompt: "", model });
    const session = {
      ...empty,
      turns: [{
        id: "turn-1",
        index: 0,
        status: "awaiting_tools" as const,
        toolCallIds: ["tool-1"],
        toolResultIds: [],
      }],
      toolCalls: {
        "tool-1": {
          id: "tool-1",
          name: "execute_code",
          args: {},
          turnId: "turn-1",
          status: "pending" as const,
        },
      },
    };

    const running = agent.runToolStep(session, "tool-1");
    await Promise.resolve();

    expect(emitted).toEqual(["tool_execution_start"]);

    finishTool();
    await running;

    expect(emitted).toContain("tool_execution_end");
  });

  it("emits an errored tool end when execution exceeds the harness timeout", async () => {
    vi.useFakeTimers();
    try {
      let receivedSignal: AbortSignal | undefined;
      const emitted: string[] = [];
      const tool = {
        ref: "code.execute_code",
        groupId: "code",
        name: "execute_code",
        label: "Execute Code",
        description: "Execute code",
        parameters: Type.Object({}),
        execute: async (_context: ToolRuntimeContext, _toolCallId: string, _params: unknown, signal?: AbortSignal) => {
          receivedSignal = signal;
          await new Promise(() => {});
          return {
            content: [{ type: "text", text: "unreachable" }],
            details: { ok: true },
          };
        },
      } satisfies RuntimeTool;

      const agent = new Agent({
        model,
        systemPrompt: "",
        tools: [tool],
        toolRuntimeContext,
        toolExecutionTimeoutMs: 5,
        onEvent: (event) => {
          emitted.push(event.type);
        },
      });
      const empty = createEmptyAgentSession({ sessionId: "session-test", systemPrompt: "", model });
      const session = {
        ...empty,
        turns: [{
          id: "turn-1",
          index: 0,
          status: "awaiting_tools" as const,
          toolCallIds: ["tool-1"],
          toolResultIds: [],
        }],
        toolCalls: {
          "tool-1": {
            id: "tool-1",
            name: "execute_code",
            args: {},
            turnId: "turn-1",
            status: "pending" as const,
          },
        },
      };

      const running = agent.runToolStep(session, "tool-1");
      await vi.advanceTimersByTimeAsync(5);
      const result = await running;

      expect(receivedSignal?.aborted).toBe(true);
      expect(result.toolResultMessage?.isError).toBe(true);
      expect(result.toolResultMessage?.content).toEqual([
        { type: "text", text: "Tool execution timed out after 5ms." },
      ]);
      expect(result.session.toolCalls["tool-1"]?.status).toBe("error");
      expect(emitted).toEqual(["tool_execution_start", "tool_execution_end", "message_start", "message_end"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks tool calls aborted when execution receives an abort signal", async () => {
    const controller = new AbortController();
    const tool = {
      ref: "code.execute_code",
      groupId: "code",
      name: "execute_code",
      label: "Execute Code",
      description: "Execute code",
      parameters: Type.Object({}),
      execute: async (_context: ToolRuntimeContext, _toolCallId: string, _params: unknown, signal?: AbortSignal) => {
        await new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        });
        return {
          content: [{ type: "text", text: "unreachable" }],
          details: { ok: true },
        };
      },
    } satisfies RuntimeTool;

    const agent = new Agent({
      model,
      systemPrompt: "",
      tools: [tool],
      toolRuntimeContext,
    });
    const empty = createEmptyAgentSession({ sessionId: "session-test", systemPrompt: "", model });
    const session = {
      ...empty,
      turns: [{
        id: "turn-1",
        index: 0,
        status: "awaiting_tools" as const,
        toolCallIds: ["tool-1"],
        toolResultIds: [],
      }],
      toolCalls: {
        "tool-1": {
          id: "tool-1",
          name: "execute_code",
          args: {},
          turnId: "turn-1",
          status: "pending" as const,
        },
      },
    };

    const running = agent.runToolStep(session, "tool-1", controller.signal);
    await Promise.resolve();
    controller.abort();
    const result = await running;

    expect(result.toolResultMessage?.isError).toBe(true);
    expect(result.session.toolCalls["tool-1"]?.status).toBe("aborted");
    expect(result.events.find((event) => event.type === "tool_execution_end")).toMatchObject({ isError: true });
  });

  it("persists tool results with details.ok false as errors", async () => {
    const tool = {
      ref: "code.execute_code",
      groupId: "code",
      name: "execute_code",
      label: "Execute Code",
      description: "Execute code",
      parameters: Type.Object({}),
      execute: async () => ({
        content: [{ type: "text", text: "Error: require is not defined" }],
        details: { ok: false },
      }),
    } satisfies RuntimeTool;

    const agent = new Agent({ model, systemPrompt: "", tools: [tool], toolRuntimeContext });
    const empty = createEmptyAgentSession({ sessionId: "session-test", systemPrompt: "", model });
    const session = {
      ...empty,
      turns: [{
        id: "turn-1",
        index: 0,
        status: "awaiting_tools" as const,
        toolCallIds: ["tool-1"],
        toolResultIds: [],
      }],
      toolCalls: {
        "tool-1": {
          id: "tool-1",
          name: "execute_code",
          args: {},
          turnId: "turn-1",
          status: "pending" as const,
        },
      },
    };

    const result = await agent.runToolStep(session, "tool-1");

    expect(result.toolResultMessage?.isError).toBe(true);
    expect(result.session.toolCalls["tool-1"]?.status).toBe("error");
    expect(result.events.find((event) => event.type === "tool_execution_end")).toMatchObject({ isError: true });
  });

  it("runs multiple pending tool calls from the same turn in one parallel step", async () => {
    let active = 0;
    let maxActive = 0;
    const tool = {
      ref: "code.execute_code",
      groupId: "code",
      name: "execute_code",
      label: "Execute Code",
      description: "Execute code",
      parameters: Type.Object({}),
      execute: async (_context: ToolRuntimeContext, _toolCallId: string) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active -= 1;
        return {
          content: [{ type: "text", text: _toolCallId }],
          details: { ok: true },
        };
      },
    } satisfies RuntimeTool;

    const agent = new Agent({ model, systemPrompt: "", tools: [tool], toolRuntimeContext });
    const empty = createEmptyAgentSession({ sessionId: "session-test", systemPrompt: "", model });
    const session = {
      ...empty,
      status: "running" as const,
      turns: [{
        id: "turn-1",
        index: 0,
        status: "awaiting_tools" as const,
        toolCallIds: ["tool-1", "tool-2"],
        toolResultIds: [],
      }],
      toolCalls: {
        "tool-1": {
          id: "tool-1",
          name: "execute_code",
          args: {},
          turnId: "turn-1",
          status: "pending" as const,
        },
        "tool-2": {
          id: "tool-2",
          name: "execute_code",
          args: {},
          turnId: "turn-1",
          status: "pending" as const,
        },
      },
    };

    const step = agent.determineNextStep(session);

    expect(step).toMatchObject({
      type: "tool",
      toolCallId: "tool-1",
      toolCallIds: ["tool-1", "tool-2"],
    });

    const result = await agent.runSingleStep(session, step!);
    const toolResults = result.session.messages.filter((message) => message.role === "toolResult");

    expect(maxActive).toBe(2);
    expect(toolResults.map((message) => message.toolCallId)).toEqual(["tool-1", "tool-2"]);
    expect(result.session.turns[0]?.toolResultIds).toEqual(["tool-1", "tool-2"]);
    expect(result.session.toolCalls["tool-1"]?.status).toBe("complete");
    expect(result.session.toolCalls["tool-2"]?.status).toBe("complete");
    expect(result.nextStep?.type).toBe("complete");
  });

  it("keeps pending async tool calls open and resumes them with stored async state", async () => {
    const calls: unknown[] = [];
    const tool = {
      ref: "code.execute_code",
      groupId: "code",
      name: "execute_code",
      label: "Execute Code",
      description: "Execute code",
      parameters: Type.Object({}),
      execute: async (_context: ToolRuntimeContext, _toolCallId: string, params: unknown) => {
        calls.push(params);
        if (calls.length === 1) {
          return {
            content: [{ type: "text", text: "still running" }],
            details: {
              ok: true,
              pending: true,
              asyncState: { kind: "test", commandId: "cmd-1" },
            },
          };
        }
        return {
          content: [{ type: "text", text: "done" }],
          details: { ok: true },
        };
      },
    } satisfies RuntimeTool;

    const agent = new Agent({ model, systemPrompt: "", tools: [tool], toolRuntimeContext });
    const empty = createEmptyAgentSession({ sessionId: "session-test", systemPrompt: "", model });
    const session = {
      ...empty,
      status: "running" as const,
      turns: [{
        id: "turn-1",
        index: 0,
        status: "awaiting_tools" as const,
        toolCallIds: ["tool-1"],
        toolResultIds: [],
      }],
      toolCalls: {
        "tool-1": {
          id: "tool-1",
          name: "execute_code",
          args: {},
          turnId: "turn-1",
          status: "pending" as const,
        },
      },
    };

    const first = await agent.runSingleStep(session, agent.determineNextStep(session)!);

    expect(first.session.messages.filter((message) => message.role === "toolResult")).toEqual([]);
    expect(first.session.toolCalls["tool-1"]?.status).toBe("running");
    expect(first.session.toolCalls["tool-1"]?.asyncState).toEqual({ kind: "test", commandId: "cmd-1" });
    expect(first.nextStep?.type).toBe("tool");

    const second = await agent.runSingleStep(first.session, first.nextStep!);

    expect(calls[1]).toEqual({ _asyncState: { kind: "test", commandId: "cmd-1" } });
    expect(second.session.messages.filter((message) => message.role === "toolResult")).toHaveLength(1);
    expect(second.session.toolCalls["tool-1"]?.status).toBe("complete");
    expect(second.nextStep?.type).toBe("complete");
  });

  it("passes Bedrock credentials as bearerToken", async () => {
    const model = {
      id: "minimax.minimax-m2.5",
      provider: "amazon-bedrock",
      api: "bedrock-converse-stream",
      maxTokens: 4096,
    } as Model<"bedrock-converse-stream">;
    let receivedOptions: Record<string, unknown> | undefined;

    const streamFn: StreamFn = ((streamModel: Model<any>, _context: Context, options?: Record<string, unknown>) => {
      receivedOptions = options;
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "hi" }],
        api: streamModel.api,
        provider: streamModel.provider,
        model: streamModel.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      };
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: "stop", message });
      return stream;
    }) as StreamFn;

    const agent = new Agent({
      model,
      systemPrompt: "",
      tools: [],
      toolRuntimeContext,
      streamFn,
      getApiKey: () => "bedrock-token",
    });

    const empty = createEmptyAgentSession({ sessionId: "session-test", systemPrompt: "", model });
    const queued = agent.enqueuePrompt(empty, "hello").session;
    await agent.runAssistantStep(queued);

    expect(receivedOptions?.apiKey).toBe("bedrock-token");
    expect(receivedOptions?.bearerToken).toBe("bedrock-token");
  });
});
