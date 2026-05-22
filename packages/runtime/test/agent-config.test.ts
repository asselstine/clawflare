import { describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream, type AssistantMessage, type Context } from "@earendil-works/pi-ai";
import { bedrockProviderModule } from "@earendil-works/pi-ai/bedrock-provider";
import { buildAgentComponents } from "../src/agent-config.js";

describe("buildAgentComponents", () => {
  it("passes AWS_BEARER_TOKEN_BEDROCK to Bedrock as bearerToken", async () => {
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

    const components = await buildAgentComponents({
      AI_PROVIDER: "amazon-bedrock",
      AI_MODEL: "minimax.minimax-m2.5",
      AWS_BEARER_TOKEN_BEDROCK: "Bearer test-token",
    } as any);

    components.streamFn(components.model, { messages: [] } as Context, {} as any);

    expect(spy).toHaveBeenCalledWith(
      components.model,
      { messages: [] },
      expect.objectContaining({ bearerToken: "test-token" }),
    );

    spy.mockRestore();
  });
});
