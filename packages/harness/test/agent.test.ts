import { describe, expect, it } from "vitest";
import { createAssistantMessageEventStream, type AssistantMessage, type Context, type Model } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { Agent, createEmptyAgentSession } from "../src/agent.js";

describe("Agent", () => {
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
