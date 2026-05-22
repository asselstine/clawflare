/**
 * Unit tests for mock AI utilities
 */
import { describe, it, expect } from "vitest";
import {
  createMockStream,
  shouldUseMockAI,
} from "../src/mock-ai.js";
import type { Model, Context, AssistantMessage } from "@earendil-works/pi-ai";

describe("mock-ai", () => {
  describe("shouldUseMockAI", () => {
    it("should return true when MOCK_AI is 'true'", () => {
      expect(shouldUseMockAI({ MOCK_AI: "true" })).toBe(true);
    });

    it("should return false when MOCK_AI is missing", () => {
      expect(shouldUseMockAI({})).toBe(false);
    });

    it("should return false for other MOCK_AI values", () => {
      expect(shouldUseMockAI({ MOCK_AI: "false" })).toBe(false);
      expect(shouldUseMockAI({ MOCK_AI: "yes" })).toBe(false);
      expect(shouldUseMockAI({ MOCK_AI: "1" })).toBe(false);
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
      expect(typeof streamFn).toBe("function");
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
      expect(startEvent).toBeDefined();
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

      expect(events.some(e => (e as { type: string }).type === "text_start")).toBe(true);
      expect(events.some(e => (e as { type: string }).type === "text_delta")).toBe(true);
      expect(events.some(e => (e as { type: string }).type === "text_end")).toBe(true);
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

      expect(textDeltas.length).toBe(1);
      expect(textDeltas[0]).toContain("Hello");
      expect(textDeltas[0]).toContain("[HARNESS MOCK]");
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

      expect(doneEvent).toBeDefined();
      expect(doneEvent!.reason).toBe("stop");
      expect(doneEvent!.message.role).toBe("assistant");
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
      expect(hasText).toBe(true);
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

      expect(textDeltas[0]).toContain("[CUSTOM]");
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

      expect(textDeltas[0]).toContain("HISTORY_TEST_MODE");
      expect(textDeltas[0]).toContain("Found 2 user messages");
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

      expect(textDeltas[0]).toContain("Array content");
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

      expect(finalMessage).toBeDefined();
      expect(typeof finalMessage!.usage.input).toBe("number");
      expect(typeof finalMessage!.usage.output).toBe("number");
      expect(finalMessage!.usage.totalTokens).toBeGreaterThan(0);
    });
  });
});
