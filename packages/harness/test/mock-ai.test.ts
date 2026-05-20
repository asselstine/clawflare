/**
 * Unit tests for mock AI utilities
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import {
  createMockStream,
  shouldUseMockAI,
} from "../src/mock-ai.js";
import type { Model, Context, AssistantMessage } from "@earendil-works/pi-ai";

describe("mock-ai", () => {
  describe("shouldUseMockAI", () => {
    it("should return true when MOCK_AI is 'true'", () => {
      assert.strictEqual(shouldUseMockAI({ MOCK_AI: "true" }), true);
    });

    it("should return false when MOCK_AI is missing", () => {
      assert.strictEqual(shouldUseMockAI({}), false);
    });

    it("should return false for other MOCK_AI values", () => {
      assert.strictEqual(shouldUseMockAI({ MOCK_AI: "false" }), false);
      assert.strictEqual(shouldUseMockAI({ MOCK_AI: "yes" }), false);
      assert.strictEqual(shouldUseMockAI({ MOCK_AI: "1" }), false);
    });
  });

  describe("createMockStream", () => {
    const mockModel = {
      id: "mock-model",
      provider: "mock",
      api: "openai-completions",
    } as Model<"openai-completions">;

    it("should return a stream function", () => {
      const streamFn = createMockStream();
      assert.strictEqual(typeof streamFn, "function");
    });

    it("should emit start event", async () => {
      const streamFn = createMockStream();
      const context: Context = {
        messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
      };

      const stream = streamFn(mockModel, context);
      const events: unknown[] = [];
      
      for await (const event of stream) {
        events.push(event);
        if (event.type === "done") break;
      }

      const startEvent = events.find(e => (e as { type: string }).type === "start");
      assert.ok(startEvent);
    });

    it("should emit text events with user message", async () => {
      const streamFn = createMockStream();
      const context: Context = {
        messages: [{ role: "user", content: "Test message", timestamp: Date.now() }],
      };

      const stream = streamFn(mockModel, context);
      const events: unknown[] = [];
      
      for await (const event of stream) {
        events.push(event);
      }

      assert.ok(events.some(e => (e as { type: string }).type === "text_start"));
      assert.ok(events.some(e => (e as { type: string }).type === "text_delta"));
      assert.ok(events.some(e => (e as { type: string }).type === "text_end"));
    });

    it("should include message content in text_delta", async () => {
      const streamFn = createMockStream();
      const context: Context = {
        messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
      };

      const stream = streamFn(mockModel, context);
      const textDeltas: string[] = [];
      
      for await (const event of stream) {
        if (event.type === "text_delta") {
          textDeltas.push(event.delta);
        }
      }

      assert.strictEqual(textDeltas.length, 1);
      assert(textDeltas[0]!.includes("Hello"));
      assert(textDeltas[0]!.includes("[HARNESS MOCK]"));
    });

    it("should emit done event with final message", async () => {
      const streamFn = createMockStream();
      const context: Context = {
        messages: [{ role: "user", content: "Test", timestamp: Date.now() }],
      };

      const stream = streamFn(mockModel, context);
      let doneEvent: { type: "done"; reason: string; message: AssistantMessage } | undefined;
      
      for await (const event of stream) {
        if (event.type === "done") {
          doneEvent = event as { type: "done"; reason: string; message: AssistantMessage };
        }
      }

      assert.ok(doneEvent);
      assert.strictEqual(doneEvent!.reason, "stop");
      assert.strictEqual(doneEvent!.message.role, "assistant");
    });

    it("should handle empty context messages", async () => {
      const streamFn = createMockStream();
      const context: Context = { messages: [] };

      const stream = streamFn(mockModel, context);
      let hasText = false;
      
      for await (const event of stream) {
        if (event.type === "text_delta") {
          hasText = true;
        }
      }

      // Should still produce output even with no user messages
      assert.strictEqual(hasText, true);
    });

    it("should respect custom response prefix", async () => {
      const streamFn = createMockStream({ responsePrefix: "[CUSTOM] " });
      const context: Context = {
        messages: [{ role: "user", content: "Test", timestamp: Date.now() }],
      };

      const stream = streamFn(mockModel, context);
      const textDeltas: string[] = [];
      
      for await (const event of stream) {
        if (event.type === "text_delta") {
          textDeltas.push(event.delta);
        }
      }

      assert(textDeltas[0]!.includes("[CUSTOM]"));
    });

    it("should handle HISTORY_TEST mode", async () => {
      const streamFn = createMockStream();
      const context: Context = {
        messages: [
          { role: "user", content: "First message", timestamp: Date.now() },
          { role: "user", content: "HISTORY_TEST: check history", timestamp: Date.now() },
        ],
      };

      const stream = streamFn(mockModel, context);
      const textDeltas: string[] = [];
      
      for await (const event of stream) {
        if (event.type === "text_delta") {
          textDeltas.push(event.delta);
        }
      }

      assert(textDeltas[0]!.includes("HISTORY_TEST_MODE"));
      assert(textDeltas[0]!.includes("Found 2 user messages"));
    });

    it("should handle array-based message content", async () => {
      const streamFn = createMockStream();
      const context: Context = {
        messages: [{
          role: "user",
          content: [{ type: "text", text: "Array content" }],
          timestamp: Date.now(),
        }],
      };

      const stream = streamFn(mockModel, context);
      const textDeltas: string[] = [];
      
      for await (const event of stream) {
        if (event.type === "text_delta") {
          textDeltas.push(event.delta);
        }
      }

      assert(textDeltas[0]!.includes("Array content"));
    });

    it("should set usage in final message", async () => {
      const streamFn = createMockStream();
      const context: Context = {
        messages: [{ role: "user", content: "Test with some length", timestamp: Date.now() }],
      };

      const stream = streamFn(mockModel, context);
      let finalMessage: AssistantMessage | undefined;
      
      for await (const event of stream) {
        if (event.type === "done") {
          finalMessage = (event as { message: AssistantMessage }).message;
        }
      }

      assert.ok(finalMessage);
      assert.strictEqual(typeof finalMessage!.usage.input, "number");
      assert.strictEqual(typeof finalMessage!.usage.output, "number");
      assert(finalMessage!.usage.totalTokens > 0);
    });
  });
});
