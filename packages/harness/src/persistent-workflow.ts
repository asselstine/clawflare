import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from "cloudflare:workers";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Env } from "./internal-types/index.js";
import { createDataLayer } from "./data/index.js";
import { coordinatorDequeueSessionInput, coordinatorAppendSessionEvents } from "./session-coordinator.js";

interface StoredWorkflowSession {
  messages: AgentMessage[];
}

function textFromMessage(message: AgentMessage): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((part): part is { type: "text"; text: string } =>
        typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text"
      )
      .map((part) => part.text)
      .join("");
  }
  return "";
}

function createMockAssistantResponse(messages: AgentMessage[], prompt: string): string {
  if (prompt.includes("HISTORY_TEST")) {
    const userMessages = messages
      .filter((message) => message.role === "user")
      .map((message, index) => `${index + 1}. ${textFromMessage(message)}`);

    const countLabel = userMessages.length === 1 ? "message" : "messages";
    return `[HARNESS MOCK] HISTORY_TEST_MODE: Found ${userMessages.length} user ${countLabel} in history: [${userMessages.join(" | ")}]`;
  }

  return `[HARNESS MOCK] I received your message: "${prompt.substring(0, 100)}${prompt.length > 100 ? "..." : ""}"`;
}

/**
 * Persistent workflow params
 */
export interface PersistentWorkflowParams {
  sessionId: string;
}

/**
 * Persistent session workflow - runs continuously per session
 * 
 * This workflow:
 * 1. Marks the session as active
 * 2. Waits for input events via the D1 queue
 * 3. Processes each input event
 * 4. Appends events to the session log
 * 5. Continues until a close event is received
 */
export class PersistentSessionWorkflow extends WorkflowEntrypoint<Env, PersistentWorkflowParams> {
  async run(event: Readonly<WorkflowEvent<unknown>>, step: WorkflowStep): Promise<{
    ok: boolean;
    sessionId: string;
    reason: string;
  }> {
    const sessionId =
      (event as unknown as { payload?: { sessionId?: string } }).payload?.sessionId ?? "unknown";

    // Mark session as active
    await step.do("mark-session-active", async () => {
      const dataLayer = createDataLayer(this.env);
      await dataLayer.runtime.setActive(sessionId, true);
    });

    let shouldContinue = true;
    let shouldWaitForWake = false;

    while (shouldContinue) {
      // On workflow startup, drain any already-queued input immediately. This
      // avoids initial prompt latency and avoids depending on wake-event timing.
      // Subsequent iterations wait for an explicit wake event.
      if (shouldWaitForWake) {
        await step.waitForEvent("session-input", {
          type: "session-input",
          timeout: "7 days",
        });
      }
      shouldWaitForWake = true;

      // Drain the D1 input queue
      let drained = false;
      
      while (!drained) {
        const { event: input, remaining } = await step.do("dequeue-input", async () => {
          return coordinatorDequeueSessionInput(this.env, sessionId);
        });

        if (!input) {
          drained = true;
          break;
        }

        // Process the input event
        if (input.type === "close") {
          await step.do("mark-session-closed", async () => {
            const dataLayer = createDataLayer(this.env);
            await dataLayer.sessions.markClosed(sessionId, "user");
            await dataLayer.runtime.setActive(sessionId, false);
          });
          shouldContinue = false;
          break;
        }

        if (input.type === "prompt") {
          await step.do("process-prompt", async () => {
            // Get the data layer
            const dataLayer = createDataLayer(this.env);

            // Mark session as processing
            await dataLayer.sessions.save({
              id: sessionId,
              workflowId: (await dataLayer.runtime.getWorkflowId(sessionId)) ?? "",
              status: "processing",
              nextEventCursor: await dataLayer.events.latestCursor(sessionId),
              updatedAt: Date.now(),
            });

            const storedSession =
              (await dataLayer.runtime.getWorkflowSession(sessionId)) as StoredWorkflowSession | null;
            const messages = storedSession?.messages ? [...storedSession.messages] : [];

            const userMessage: AgentMessage = {
              role: "user",
              content: input.content,
              timestamp: Date.now(),
            };
            messages.push(userMessage);

            // The full agent loop can be swapped in here; for now this consumes
            // real queued input and persists deterministic assistant output in
            // MOCK_AI-compatible form so polling clients receive messages.
            const assistantText = createMockAssistantResponse(messages, input.content);
            const assistantMessage = {
              role: "assistant",
              content: [{ type: "text", text: assistantText }],
              api: "openai-completions",
              provider: "mock",
              model: "mock-model",
              usage: {
                input: input.content.length,
                output: assistantText.length,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: input.content.length + assistantText.length,
                cost: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  total: 0,
                },
              },
              stopReason: "stop",
              timestamp: Date.now(),
            } as AgentMessage;
            messages.push(assistantMessage);

            await dataLayer.runtime.saveWorkflowSession(sessionId, { messages });

            await coordinatorAppendSessionEvents(this.env, sessionId, [
              {
                type: "message",
                timestamp: userMessage.timestamp ?? Date.now(),
                message: userMessage,
              },
              {
                type: "message",
                timestamp: assistantMessage.timestamp ?? Date.now(),
                message: assistantMessage,
              },
              {
                type: "done",
                timestamp: Date.now(),
                reason: "stop",
                message: assistantMessage,
              },
            ]);

            // Mark session as idle when done
            await dataLayer.sessions.save({
              id: sessionId,
              workflowId: (await dataLayer.runtime.getWorkflowId(sessionId)) ?? "",
              status: "idle",
              nextEventCursor: await dataLayer.events.latestCursor(sessionId),
              updatedAt: Date.now(),
            });

            return { processed: true };
          });
        }

        // If queue is empty, break out to wait for next wake event
        if (remaining === 0) {
          drained = true;
        }
      }
    }

    // Mark session inactive
    await step.do("mark-session-inactive", async () => {
      const dataLayer = createDataLayer(this.env);
      await dataLayer.runtime.setActive(sessionId, false);
    });

    return { ok: true, sessionId, reason: "closed" };
  }
}
