import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from "cloudflare:workers";
import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { Env } from "../internal-types/index.js";
import {
  InputQueueRepository,
  SessionEventRepository,
  SessionRepository,
  SessionRuntimeRepository,
  type NewSessionEvent,
  type SessionInputEvent,
} from "../data/index.js";
import { Agent, createEmptyAgentSession, type AgentSessionState, type NextStepInfo } from "./agent.js";
import { buildAgentComponents, buildAgentComponentsFromResolved } from "./agent-config.js";
import { createMockStream, shouldUseMockAI } from "./mock-ai.js";
import { createTools } from "../modules/tools/tools.service.js";
import { logTiming, timingStart } from "../lib/timing.js";
import { logger, errorMessage } from "../lib/logger.js";
import { resolveModelConnectionForSession } from "../modules/model-connections/model-connections.service.js";

const DEFAULT_SYSTEM_PROMPT = `You are Clawflare, an AI agent running as a web service. Your core tools allow you to execute code, and egress handlers can afford authorized fetches from external HTTP APIs and supported HTTPS protocol endpoints such as native Git smart HTTP. Before saying you lack access to an external service, account, resource, profile, API, or HTTPS git remote, inspect the configured egress handlers with your search tool. Treat enabled, configured egress handlers as available authenticated routes for matching domains; treat unavailable or disabled handlers as not currently usable. If an authenticated request reaches the service but receives a 401 or 403, report that the configured credential was rejected or lacks permission instead of claiming no credential path exists. When using code execution tools, provide JavaScript as an ES module with a default exported async function: export default async function(input, env) { ... }. Return values or write to console.log for any output that should be visible; do not infer or invent results that are absent from tool output.

When using container_bash, do not specify the timeoutMs parameter unless you specifically need a shorter timeout than the default 30 minutes. Let the system use its default timeout. Do not guess or make up timeouts. If you need longer than 30 minutes, you may specify up to 60 minutes (3600000ms).`;  

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
  env: Env,
  eventsRepo: SessionEventRepository,
  sessionId: string,
  events: AgentEvent[],
): Promise<void> {
  if (events.length === 0) return;
  const appendStart = timingStart();
  await eventsRepo.append(sessionId, toSessionEvents(events));
  logTiming(env, sessionId, "workflow.events.appended", appendStart, {
    eventCount: events.length,
    eventTypes: events.map((event) => event.type),
  });
}

async function appendErrorEvent(
  eventsRepo: SessionEventRepository,
  sessionId: string,
  message: string,
): Promise<void> {
  await eventsRepo.append(sessionId, [
    {
      type: "error",
      timestamp: Date.now(),
      errorMessage: message,
    },
  ]);
}

async function getSessionWorkspaceId(env: Env, sessionId: string): Promise<string> {
  const sessions = new SessionRepository(env.DB);
  const session = await sessions.findById(sessionId);
  return session?.workspaceId ?? "default-workspace";
}

async function createWorkflowAgent(
  env: Env,
  ctx: ExecutionContext | undefined,
  sessionId: string,
  onEvent?: (event: AgentEvent) => void | Promise<void>,
): Promise<Agent> {
  const componentsStart = timingStart();
  
  // Fetch workspace ID for session to scope tool operations
  const workspaceId = await getSessionWorkspaceId(env, sessionId);
  
  // Resolve model connection from session using session-scoped secret auth.
  const resolvedModel = await resolveModelConnectionForSession(env, sessionId, {
    type: "session",
    sessionId,
  });
  
  // Build agent components - prefer session model, fallback to env
  const components = resolvedModel
    ? await buildAgentComponentsFromResolved(resolvedModel)
    : await buildAgentComponents();
  
  const streamFn = shouldUseMockAI(env) ? createMockStream() : components.streamFn;
  
  // Create tools with workspace context
  const tools = createTools(env, ctx, { sessionId, workspaceId });
  
  logTiming(env, sessionId, "workflow.agent.created", componentsStart, {
    model: components.model.id,
    provider: components.model.provider,
    toolCount: tools.length,
    mockAI: shouldUseMockAI(env),
    workspaceId,
    modelConnectionId: resolvedModel?.id,
  });

  return new Agent({
    model: components.model,
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    tools,
    streamFn,
    getApiKey: () => components.getApiKey(),
    debugTiming: (phase, startedAt, details) => logTiming(env, sessionId, `agent.${phase}`, startedAt, details),
    onEvent,
  });
}

async function loadAgentSession(
  env: Env,
  sessionId: string,
): Promise<AgentSessionState> {
  const runtime = new SessionRuntimeRepository(env.DB);
  const loadStart = timingStart();
  
  // Resolve model connection from session using session-scoped secret auth.
  const resolvedModel = await resolveModelConnectionForSession(env, sessionId, {
    type: "session",
    sessionId,
  });
  
  // Build agent components - prefer session model, fallback to env
  const components = resolvedModel
    ? await buildAgentComponentsFromResolved(resolvedModel)
    : await buildAgentComponents();
    
  const stored = await runtime.getWorkflowSession(sessionId);
  logTiming(env, sessionId, "workflow.session.loaded", loadStart, {
    hasStoredSession: Boolean(stored),
    storedSessionValid: isAgentSessionState(stored),
    modelConnectionId: resolvedModel?.id,
  });

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
  sessions: SessionRepository,
  runtime: SessionRuntimeRepository,
  events: SessionEventRepository,
  sessionId: string,
  status: "processing" | "idle" | "error",
  errorMessage?: string,
): Promise<void> {
  // Get existing session to preserve workspaceId
  const existingSession = await sessions.findById(sessionId);
  
  await sessions.save({
    id: sessionId,
    workspaceId: existingSession?.workspaceId ?? "default-workspace",
    workflowId: (await runtime.getWorkflowId(sessionId)) ?? "",
    status,
    nextEventCursor: await events.latestCursor(sessionId),
    updatedAt: Date.now(),
    errorMessage,
    maxQueueSize: existingSession?.maxQueueSize ?? 100,
    idleTimeout: existingSession?.idleTimeout ?? "7 days",
  });
}

async function markPromptError(
  env: Env,
  sessionId: string,
  message: string,
): Promise<void> {
  const runtime = new SessionRuntimeRepository(env.DB);
  const events = new SessionEventRepository(env.DB);
  const sessions = new SessionRepository(env.DB);
  const stored = await loadAgentSession(env, sessionId);
  const erroredSession: AgentSessionState = {
    ...stored,
    updatedAt: Date.now(),
    status: "error",
    errorMessage: message,
  };

  await runtime.saveWorkflowSession(sessionId, erroredSession);
  await appendErrorEvent(events, sessionId, message);
  await saveSessionMetadata(sessions, runtime, events, sessionId, "error", message);
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

    const workflowEventType = (event as unknown as { type?: unknown }).type;
    logTiming(this.env, sessionId, "workflow.run.start", undefined, {
      workflowEventType: typeof workflowEventType === "string" ? workflowEventType : undefined,
    });

    await step.do("mark-session-active", async () => {
      const markStart = timingStart();
      const runtime = new SessionRuntimeRepository(this.env.DB);
      await runtime.setActive(sessionId, true);
      logTiming(this.env, sessionId, "workflow.mark_active.done", markStart);
    });

    let shouldContinue = true;
    let shouldWaitForWake = false;
    let dequeueStep = 0;
    let inputStep = 0;

    while (shouldContinue) {
      // On workflow startup, drain any already-queued input immediately.
      // Subsequent iterations wait for an explicit wake event.
      if (shouldWaitForWake) {
        logTiming(this.env, sessionId, "workflow.wait_for_wake.start");
        const waitStart = timingStart();
        await step.waitForEvent("session-input", {
          type: "session-input",
          timeout: "7 days",
        });
        logTiming(this.env, sessionId, "workflow.wait_for_wake.done", waitStart);
      }
      shouldWaitForWake = true;

      let drained = false;

      while (!drained) {
        const dequeueStart = timingStart();
        const { event: input, remaining } = await step.do(`dequeue-input-${dequeueStep++}`, async () => {
          const inputQueue = new InputQueueRepository(this.env.DB);
          return inputQueue.dequeue(sessionId);
        });
        logTiming(this.env, sessionId, "workflow.input.dequeued", dequeueStart, {
          inputType: input?.type,
          remaining,
        });

        if (!input) {
          drained = true;
          break;
        }

        if (input.type === "close") {
          await step.do(`mark-session-closed-${inputStep++}`, async () => {
            const closeStart = timingStart();
            const sessions = new SessionRepository(this.env.DB);
            const runtime = new SessionRuntimeRepository(this.env.DB);
            await sessions.markClosed(sessionId, "user");
            await runtime.setActive(sessionId, false);
            logTiming(this.env, sessionId, "workflow.session.closed", closeStart);
          });
          shouldContinue = false;
          break;
        }

        if (input.type === "prompt") {
          const promptStart = timingStart();
          logTiming(this.env, sessionId, "workflow.prompt.start", undefined, {
            promptLength: input.content.length,
            maxTurns: input.maxTurns,
          });
          await this.processPrompt(sessionId, input, step, inputStep++);
          logTiming(this.env, sessionId, "workflow.prompt.done", promptStart);
        }

        if (remaining === 0) {
          drained = true;
        }
      }
    }

    await step.do("mark-session-inactive", async () => {
      const inactiveStart = timingStart();
      const runtime = new SessionRuntimeRepository(this.env.DB);
      await runtime.setActive(sessionId, false);
      logTiming(this.env, sessionId, "workflow.mark_inactive.done", inactiveStart);
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
        const sessions = new SessionRepository(this.env.DB);
        const runtime = new SessionRuntimeRepository(this.env.DB);
        const events = new SessionEventRepository(this.env.DB);
        const metadataStart = timingStart();
        await saveSessionMetadata(sessions, runtime, events, sessionId, "processing");
        logTiming(this.env, sessionId, "workflow.session.processing_saved", metadataStart);

        const agent = await createWorkflowAgent(this.env, this.ctx, sessionId);
        const loadedSession = await loadAgentSession(this.env, sessionId);
        const enqueueStart = timingStart();
        const result = agent.enqueuePrompt(loadedSession, input.content);
        const nextStep = agent.determineNextStep(result.session) ?? null;
        logTiming(this.env, sessionId, "workflow.prompt.enqueued", enqueueStart, {
          eventCount: result.events.length,
          nextStepType: nextStep?.type,
          nextStepId: nextStep?.stepId,
        });

        const saveStart = timingStart();
        await runtime.saveWorkflowSession(sessionId, result.session);
        logTiming(this.env, sessionId, "workflow.session.saved", saveStart, {
          status: result.session.status,
          messageCount: result.session.messages.length,
          turnCount: result.session.turns.length,
        });
        await appendAgentEvents(this.env, events, sessionId, result.events);

        return {
          session: serializeForWorkflow(result.session),
          nextStep: serializeForWorkflow(nextStep),
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
            const stepStart = timingStart();
            logTiming(this.env, sessionId, "workflow.agent_step.start", undefined, {
              stepType: currentStep.type,
              stepId: currentStep.stepId,
              displayName: currentStep.displayName,
              toolCallId: currentStep.toolCallId,
            });
            const runtime = new SessionRuntimeRepository(this.env.DB);
            const events = new SessionEventRepository(this.env.DB);
            const livePersistedEvents = new Set<AgentEvent>();
            const agent = await createWorkflowAgent(this.env, this.ctx, sessionId, async (event) => {
              livePersistedEvents.add(event);
              await appendAgentEvents(this.env, events, sessionId, [event]);
            });
            const result = await agent.runSingleStep(agentSession, currentStep);
            logTiming(this.env, sessionId, "workflow.agent_step.ran", stepStart, {
              stepType: currentStep.type,
              stepId: currentStep.stepId,
              eventCount: result.events.length,
              nextStepType: result.nextStep?.type,
              nextStepId: result.nextStep?.stepId,
              sessionStatus: result.session.status,
            });

            const saveStart = timingStart();
            await runtime.saveWorkflowSession(sessionId, result.session);
            logTiming(this.env, sessionId, "workflow.session.saved", saveStart, {
              status: result.session.status,
              messageCount: result.session.messages.length,
              turnCount: result.session.turns.length,
            });
            const unpersistedEvents = result.events.filter((event) => !livePersistedEvents.has(event));
            await appendAgentEvents(this.env, events, sessionId, unpersistedEvents);

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
            const limitStart = timingStart();
            const runtime = new SessionRuntimeRepository(this.env.DB);
            const events = new SessionEventRepository(this.env.DB);
            const erroredSession: AgentSessionState = {
              ...agentSession,
              updatedAt: Date.now(),
              status: "error",
              errorMessage: message,
            };

            await runtime.saveWorkflowSession(sessionId, erroredSession);
            await appendErrorEvent(events, sessionId, message);
            logTiming(this.env, sessionId, "workflow.max_turns_saved", limitStart, { maxTurns });
            return serializeForWorkflow(erroredSession);
          });

          agentSession = requireAgentSessionState(limited);
          nextStep = undefined;
        }
      }

      await step.do(`finalize-prompt-${inputIndex}`, async () => {
        const finalizeStart = timingStart();
        const sessions = new SessionRepository(this.env.DB);
        const runtime = new SessionRuntimeRepository(this.env.DB);
        const events = new SessionEventRepository(this.env.DB);
        const status = agentSession.status === "error" ? "error" : "idle";
        logTiming(this.env, sessionId, "workflow.prompt.finalizing", finalizeStart, { 
          currentSessionStatus: agentSession.status,
          willSetStatusTo: status 
        });
        await saveSessionMetadata(sessions, runtime, events, sessionId, status, agentSession.errorMessage);
        logTiming(this.env, sessionId, "workflow.prompt.finalized", finalizeStart, { status });
      });
    } catch (error) {
      const message = errorMessage(error);

      // Always log errors to the server logs - this is NOT gated by CLAWFLARE_DEBUG_TIMING
      logger.error("Workflow prompt failed", error, {
        sessionId,
        inputIndex,
        maxTurns,
      });

      // Optional timing-only marker - this is gated by CLAWFLARE_DEBUG_TIMING
      logTiming(this.env, sessionId, "workflow.prompt.error", undefined, {
        error: message,
      });

      await step.do(`prompt-error-${inputIndex}`, async () => {
        const errorStart = timingStart();
        await markPromptError(this.env, sessionId, message);
        logTiming(this.env, sessionId, "workflow.prompt.error_saved", errorStart);
      });
    }
  }
}
