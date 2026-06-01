import { describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream, type AssistantMessage, type Context } from "@earendil-works/pi-ai";
import { bedrockProviderModule } from "@earendil-works/pi-ai/bedrock-provider";
import { buildAgentComponentsFromResolved } from "../src/runtime/agent-config.js";

describe("buildAgentComponents", () => {
  it("passes AWS_BEARER_TOKEN_BEDROCK to Bedrock as bearerToken from resolved model connection", async () => {
    const stream = createAssistantMessageEventStream();
    const message: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
      api: "bedrock-converse-stream",
      provider: "amazon-bedrock",
      model: "minimax.minimax-m2.5",
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
    stream.push({ type: "done", reason: "stop", message });

    const spy = vi.spyOn(bedrockProviderModule, "streamBedrock").mockReturnValue(stream);

    // Build components from a resolved model connection
    const components = await buildAgentComponentsFromResolved({
      id: "test-connection",
      provider: "amazon-bedrock",
      modelName: "minimax.minimax-m2.5",
      secrets: {
        AWS_BEARER_TOKEN_BEDROCK: "test-token",
      },
      config: {},
    });

    components.streamFn(components.model, { messages: [] } as Context, {} as any);

    expect(spy).toHaveBeenCalledWith(
      components.model,
      { messages: [] },
      expect.objectContaining({ bearerToken: "test-token" }),
    );

    spy.mockRestore();
  });
});
