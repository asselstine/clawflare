import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from "cloudflare:workers";
import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { Env } from "./internal-types/index.js";
import type { DataLayer, NewSessionEvent, SessionInputEvent } from "./data/index.js";
import { getDataLayer } from "./data/index.js";
import { Agent, createEmptyAgentSession, type AgentSessionState, type NextStepInfo } from "./agent.js";
import { buildAgentComponents } from "./agent-config.js";
import { createMockStream, shouldUseMockAI } from "./mock-ai.js";
import { createTools } from "./tools/index.js";

const DEFAULT_SYSTEM_PROMPT = `You are Clawflare, an AI agent running inside a Cloudflare Worker.
Use the available tools when they are helpful, keep responses concise, and preserve useful context across turns.`;

type JsonValue = null | string | number | boolean | JsonValue[] | { [key: string]: JsonValue };

interface StoredWorkflowSession {
  messages?: AgentMessage[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isAgentSessionState(value: unknown): value is AgentSessionState {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.systemPrompt === "string" &&
    isRecord(value.model) &&
    Array.isArray(value.messages) &&
    Array.isArray(value.turns) &&
    isRecord(value.toolCalls) &&
    typeof value.status === "string"
  );
}

function requireAgentSessionState(value: unknown): AgentSessionState {
  if (!isAgentSessionState(value)) {
    throw new Error("Workflow step returned an invalid agent session");
  }
  return value;
}

function isNextStepInfo(value: unknown): value is NextStepInfo {
  return (
    isRecord(value) &&
    (value.type === "assistant" || value.type === "tool" || value.type === "complete" || value.type === "finalize") &&
    typeof value.stepId === "string" &&
    typeof value.displayName === "string" &&
    (value.toolCallId === undefined || typeof value.toolCallId === "string")
  );
}

function optionalNextStepInfo(value: unknown): NextStepInfo | undefined {
  if (value === null || value === undefined) return undefined;
  if (!isNextStepInfo(value)) {
    throw new Error("Workflow step returned an invalid next step");
  }
  return value;
}

function serializeForWorkflow(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

async function runWorkflowStep<T>(
  step: WorkflowStep,
  name: string,
  callback: () => Promise<T>,
): Promise<T> {
  return (step.do as unknown as (
    stepName: string,
    stepCallback: () => Promise<T>,
  ) => Promise<T>)(name, callback);
}

function messageTimestamp(event: AgentEvent): number | undefined {
  if (!("message" in event) || !isRecord(event.message)) return undefined;
  return typeof event.message.timestamp === "number" ? event.message.timestamp : undefined;
}

function toSessionEvents(events: AgentEvent[]): NewSessionEvent[] {
  return events.map((event) => ({
    ...event,
    timestamp: messageTimestamp(event) ?? Date.now(),
  }));
}

async function appendAgentEvents(
  dataLayer: DataLayer,
  sessionId: string,
  events: AgentEvent[],
): Promise<void> {
  if (events.length === 0) return;
  await dataLayer.events.append(sessionId, toSessionEvents(events));
}

async function appendErrorEvent(
  dataLayer: DataLayer,
  sessionId: string,
  message: string,
): Promise<void> {
  await dataLayer.events.append(sessionId, [
    {
      type: "error",
      timestamp: Date.now(),
      errorMessage: message,
    },
  ]);
}

async function createWorkflowAgent(env: Env): Promise<Agent> {
  const components = await buildAgentComponents(env);
  const streamFn = shouldUseMockAI(env) ? createMockStream() : components.streamFn;

  return new Agent({
    model: components.model,
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    tools: createTools(env),
    streamFn,
    getApiKey: () => components.getApiKey(),
  });
}

async function loadAgentSession(
  env: Env,
  sessionId: string,
): Promise<AgentSessionState> {
  const dataLayer = getDataLayer(env);
  const components = await buildAgentComponents(env);
  const stored = await dataLayer.runtime.getWorkflowSession(sessionId);

  if (isAgentSessionState(stored)) {
    return stored;
  }

  const messages = isRecord(stored) && Array.isArray((stored as StoredWorkflowSession).messages)
    ? [...(stored as StoredWorkflowSession).messages!]
    : [];

  return createEmptyAgentSession({
    sessionId,
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    model: components.model,
    messages,
  });
}

async function saveSessionMetadata(
  dataLayer: DataLayer,
  sessionId: string,
  status: "processing" | "idle" | "error",
  errorMessage?: string,
): Promise<void> {
  await dataLayer.sessions.save({
    id: sessionId,
    workflowId: (await dataLayer.runtime.getWorkflowId(sessionId)) ?? "",
    status,
    nextEventCursor: await dataLayer.events.latestCursor(sessionId),
    updatedAt: Date.now(),
    errorMessage,
  });
}

async function markPromptError(
  env: Env,
  sessionId: string,
  message: string,
): Promise<void> {
  const dataLayer = getDataLayer(env);
  const stored = await loadAgentSession(env, sessionId);
  const erroredSession: AgentSessionState = {
    ...stored,
    updatedAt: Date.now(),
    status: "error",
    errorMessage: message,
  };

  await dataLayer.runtime.saveWorkflowSession(sessionId, erroredSession);
  await appendErrorEvent(dataLayer, sessionId, message);
  await saveSessionMetadata(dataLayer, sessionId, "error", message);
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
 * 3. Processes each input event through the Agent state machine
 * 4. Persists the agent snapshot and appends agent events to the session log
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

    await step.do("mark-session-active", async () => {
      const dataLayer = getDataLayer(this.env);
      await dataLayer.runtime.setActive(sessionId, true);
    });

    let shouldContinue = true;
    let shouldWaitForWake = false;
    let dequeueStep = 0;
    let inputStep = 0;

    while (shouldContinue) {
      // On workflow startup, drain any already-queued input immediately.
      // Subsequent iterations wait for an explicit wake event.
      if (shouldWaitForWake) {
        await step.waitForEvent("session-input", {
          type: "session-input",
          timeout: "7 days",
        });
      }
      shouldWaitForWake = true;

      let drained = false;

      while (!drained) {
        const { event: input, remaining } = await step.do(`dequeue-input-${dequeueStep++}`, async () => {
          return getDataLayer(this.env).inputQueue.dequeue(sessionId);
        });

        if (!input) {
          drained = true;
          break;
        }

        if (input.type === "close") {
          await step.do(`mark-session-closed-${inputStep++}`, async () => {
            const dataLayer = getDataLayer(this.env);
            await dataLayer.sessions.markClosed(sessionId, "user");
            await dataLayer.runtime.setActive(sessionId, false);
          });
          shouldContinue = false;
          break;
        }

        if (input.type === "prompt") {
          await this.processPrompt(sessionId, input, step, inputStep++);
        }

        if (remaining === 0) {
          drained = true;
        }
      }
    }

    await step.do("mark-session-inactive", async () => {
      const dataLayer = getDataLayer(this.env);
      await dataLayer.runtime.setActive(sessionId, false);
    });

    return { ok: true, sessionId, reason: "closed" };
  }

  private async processPrompt(
    sessionId: string,
    input: Extract<SessionInputEvent, { type: "prompt" }>,
    step: WorkflowStep,
    inputIndex: number,
  ): Promise<void> {
    let agentSession: AgentSessionState;
    let nextStep: NextStepInfo | undefined;
    let completedTurns = 0;
    let agentStep = 0;
    const maxTurns = input.maxTurns ?? 20;

    try {
      const enqueued = await runWorkflowStep(step, `enqueue-prompt-${inputIndex}`, async () => {
        const dataLayer = getDataLayer(this.env);
        await saveSessionMetadata(dataLayer, sessionId, "processing");

        const agent = await createWorkflowAgent(this.env);
        const loadedSession = await loadAgentSession(this.env, sessionId);
        const result = agent.enqueuePrompt(loadedSession, input.content);

        await dataLayer.runtime.saveWorkflowSession(sessionId, result.session);
        await appendAgentEvents(dataLayer, sessionId, result.events);

        return {
          session: serializeForWorkflow(result.session),
          nextStep: serializeForWorkflow(agent.determineNextStep(result.session) ?? null),
        };
      });

      agentSession = requireAgentSessionState(enqueued.session);
      nextStep = optionalNextStepInfo(enqueued.nextStep);

      while (nextStep) {
        const currentStep = nextStep;
        const stepResult = await runWorkflowStep(
          step,
          `agent-${inputIndex}-${agentStep++}-${currentStep.stepId}`,
          async () => {
            const dataLayer = getDataLayer(this.env);
            const agent = await createWorkflowAgent(this.env);
            const result = await agent.runSingleStep(agentSession, currentStep);

            await dataLayer.runtime.saveWorkflowSession(sessionId, result.session);
            await appendAgentEvents(dataLayer, sessionId, result.events);

            return {
              session: serializeForWorkflow(result.session),
              nextStep: serializeForWorkflow(result.nextStep ?? null),
            };
          },
        );

        agentSession = requireAgentSessionState(stepResult.session);
        nextStep = optionalNextStepInfo(stepResult.nextStep);

        if (currentStep.type === "complete") {
          completedTurns += 1;
        }

        if (nextStep && completedTurns >= maxTurns) {
          const message = `Agent stopped after reaching maxTurns (${maxTurns}).`;
          const limited = await runWorkflowStep(step, `agent-${inputIndex}-max-turns`, async () => {
            const dataLayer = getDataLayer(this.env);
            const erroredSession: AgentSessionState = {
              ...agentSession,
              updatedAt: Date.now(),
              status: "error",
              errorMessage: message,
            };

            await dataLayer.runtime.saveWorkflowSession(sessionId, erroredSession);
            await appendErrorEvent(dataLayer, sessionId, message);
            return serializeForWorkflow(erroredSession);
          });

          agentSession = requireAgentSessionState(limited);
          nextStep = undefined;
        }
      }

      await step.do(`finalize-prompt-${inputIndex}`, async () => {
        const dataLayer = getDataLayer(this.env);
        const status = agentSession.status === "error" ? "error" : "idle";
        await saveSessionMetadata(dataLayer, sessionId, status, agentSession.errorMessage);
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await step.do(`prompt-error-${inputIndex}`, async () => {
        await markPromptError(this.env, sessionId, message);
      });
    }
  }
}
