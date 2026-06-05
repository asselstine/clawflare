// Mock AI stream function for testing
// This replaces the real AI stream with a mock that processes inputs and returns responses
// while still executing the full agent loop, tool calls, and event streaming

import type { 
  Model, 
  Api, 
  Context, 
  SimpleStreamOptions, 
  AssistantMessage,
  AssistantMessageEventStream,
  TextContent,
  UserMessage,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

/**
 * Mock AI provider and model for testing
 * Used when no real model is configured
 */
export const MOCK_AI_PROVIDER = "amazon-bedrock";
export const MOCK_AI_MODEL = "minimax.minimax-m2.5";

/**
 * Creates a mock stream function that simulates AI responses
 * without making actual API calls. This allows full testing of
 * the agent loop, tool execution, and event handling.
 * 
 * Special behavior: If the prompt contains "HISTORY_TEST", the mock will
 * echo back all previous user messages in the response, allowing e2e
 * tests to verify that message history is being preserved.
 */
export function createMockStream(options?: {
  /** Prefix for mock responses */
  responsePrefix?: string;
  /** Enable tool call simulation */
  enableTools?: boolean;
  /** Test mode for history verification */
  testMode?: boolean;
}): (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream {
  const { responsePrefix = "[HARNESS MOCK] " } = options || {};

  return (_model: Model<Api>, context: Context, _streamOptions?: SimpleStreamOptions): AssistantMessageEventStream => {
    // Create an EventStream using the pi-ai utility
    const stream = createAssistantMessageEventStream();
    
    // Process the context messages to generate a response
    const messages = context.messages;
    const lastUserMessage = messages
      .slice()
      .reverse()
      .find(m => m.role === "user");
    
    const userContent = lastUserMessage?.content;
    let userText = "";
    
    if (typeof userContent === "string") {
      userText = userContent;
    } else if (Array.isArray(userContent)) {
      userText = userContent
        .filter((c): c is TextContent => c.type === "text")
        .map(c => c.text)
        .join("");
    }

    // Check for HISTORY_TEST mode - echo all previous user messages
    let responseText: string;
    if (userText.includes("HISTORY_TEST")) {
      // Collect all user messages from history
      const userMessages = messages
        .filter((m): m is UserMessage => m.role === "user")
        .map((m, i) => {
          if (typeof m.content === "string") {
            return `${i + 1}. ${m.content}`;
          } else if (Array.isArray(m.content)) {
            const text = m.content
              .filter((c): c is TextContent => c.type === "text")
              .map(c => c.text)
              .join("");
            return `${i + 1}. ${text}`;
          }
          return `${i + 1}. (non-text content)`;
        });
      
      if (userMessages.length === 1) {
        responseText = `${responsePrefix}HISTORY_TEST_MODE: Found ${userMessages.length} user message in history: [${userMessages.join(" | ")}]`;
      } else {
        responseText = `${responsePrefix}HISTORY_TEST_MODE: Found ${userMessages.length} user messages in history: [${userMessages.join(" | ")}]`;
      }
    } else {
      // Generate a mock response
      responseText = `${responsePrefix}I received your message: "${userText.substring(0, 100)}${userText.length > 100 ? "..." : ""}"`;
    }

    // Simulate streaming with events - send all immediately without async delays
    const simulateStreaming = () => {
      const now = Date.now();
      
      // Create the assistant message
      const baseMessage: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "" }],
        api: "openai-completions",
        provider: "mock",
        model: "mock-model",
        usage: {
          input: userText.length,
          output: responseText.length,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: userText.length + responseText.length,
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
          },
        },
        stopReason: "stop",
        timestamp: now,
      };

      // Send start event
      stream.push({
        type: "start",
        partial: { ...baseMessage },
      });

      // Send text_start event
      stream.push({
        type: "text_start",
        contentIndex: 0,
        partial: { ...baseMessage },
      });

      // Send all text as one delta (no streaming simulation)
      stream.push({
        type: "text_delta",
        contentIndex: 0,
        delta: responseText,
        partial: {
          ...baseMessage,
          content: [{ type: "text", text: responseText }],
        },
      });

      // Send text_end event  
      stream.push({
        type: "text_end",
        contentIndex: 0,
        content: responseText,
        partial: {
          ...baseMessage,
          content: [{ type: "text", text: responseText }],
        },
      });

      // Send done event with final message
      const finalMessage: AssistantMessage = {
        ...baseMessage,
        content: [{ type: "text", text: responseText }],
      };
      
      stream.push({
        type: "done",
        reason: "stop",
        message: finalMessage,
      });
      
      stream.end(finalMessage);
    };

    // Run synchronously
    simulateStreaming();

    return stream;
  };
}

/**
 * Determines if we should use mock AI mode based on environment
 * Only returns true if MOCK_AI is explicitly set to "true"
 * CLAWFLARE_API_TOKEN is no longer used for this purpose.
 */
export function shouldUseMockAI(env: { MOCK_AI?: string }): boolean {
  // Only use mock if explicitly enabled
  return env.MOCK_AI === "true";
}
