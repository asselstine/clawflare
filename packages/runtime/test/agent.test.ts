import { describe, expect, it } from "vitest";
import { createAssistantMessageEventStream, type AssistantMessage, type Context, type Model } from "@earendil-works/pi-ai";
import type { AgentTool, StreamFn } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { Agent, createEmptyAgentSession } from "../src/agent.js";

describe("Agent", () => {
  const model = {
    id: "test-model",
    provider: "test-provider",
    api: "openai-chat-completions",
    maxTokens: 4096,
  } as Model<any>;

  it("persists tool results with details.ok false as errors", async () => {
    const tool = {
      name: "execute_code",
      label: "Execute Code",
      description: "Execute code",
      parameters: Type.Object({}),
      execute: async () => ({
        content: [{ type: "text", text: "Error: require is not defined" }],
        details: { ok: false },
      }),
    } satisfies AgentTool;

    const agent = new Agent({ model, systemPrompt: "", tools: [tool] });
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

    expect(result.toolResultMessage.isError).toBe(true);
    expect(result.session.toolCalls["tool-1"]?.status).toBe("error");
    expect(result.events.find((event) => event.type === "tool_execution_end")).toMatchObject({ isError: true });
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
