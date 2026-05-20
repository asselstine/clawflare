// Clawflare Workflow Agent - durable, workflow-native agent execution.
//
// Workflow is an INTERNAL implementation detail - clients use session-based API.
import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from "cloudflare:workers";
import type { Env, ChatRequest } from "./types";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { createTools } from "./tools";
import { createMockStream, shouldUseMockAI } from "./mock-ai";
import { streamSimple } from "@earendil-works/pi-ai";
import {
  resolveConfiguredModel,
  getApiKeyForProvider,
  createBedrockStreaming,
  getSystemPrompt,
  type BuildAgentComponentsResult,
} from "./agent-config";
import {
  Agent,
  createEmptyAgentSession,
  type AgentSessionState,
  type NextStepInfo,
} from "./agent";
import {
  loadSession,
  saveSession,
} from "./workflow-state";
import {
  appendSessionEvents,
  loadSessionState,
  markSessionError,
  saveSessionState,
} from "./session-store";
import { logTiming, timingStart } from "./diagnostics";

interface WorkflowInput {
  sessionId: string;
  prompt: string;
  maxTurns?: number;
}

interface InitializedState {
  session: AgentSessionState;
  firstStep?: NextStepInfo;
}

interface StepExecutionResult {
  sessionId: string;
  turnCount: number;
  status?: "error" | "processing";
}

const DEFAULT_MAX_TURNS = 20;

/**
 * Start workflow internally. Session ID is exposed to client, workflow ID is not.
 */
export async function startAgentWorkflow(
  env: Env,
  request: ChatRequest,
): Promise<{ sessionId: string }> {
  if (request.type !== "prompt" || !request.content) {
    throw new Error("Invalid request. type='prompt' and content required");
  }

  const sessionId = request.sessionId || crypto.randomUUID();
  const workflowId = crypto.randomUUID();
  const maxTurns = request.maxTurns ?? DEFAULT_MAX_TURNS;
  const createStart = timingStart();
  logTiming(env, sessionId, "workflow.create.start", undefined, { workflowId, maxTurns });

  await env.AGENT_WORKFLOW.create({
    id: workflowId,
    params: {
      sessionId,
      prompt: request.content,
      maxTurns,
    },
  });

  logTiming(env, sessionId, "workflow.create.done", createStart, { workflowId });
  return { sessionId };
}

export class Workflow extends WorkflowEntrypoint<Env, WorkflowInput> {
  async run(event: WorkflowEvent<WorkflowInput>, step: WorkflowStep) {
    const { sessionId } = event.payload;

    try {
      return await this.runWorkflow(event, step);
    } catch (error) {
      logWorkflowException(this.env, sessionId, error);
      await markSessionError(this.env, sessionId, error);
      throw error;
    }
  }

  private async runWorkflow(event: WorkflowEvent<WorkflowInput>, step: WorkflowStep) {
    const workflowRunStart = timingStart();
    const { sessionId, prompt, maxTurns = DEFAULT_MAX_TURNS } = event.payload;
    logTiming(this.env, sessionId, "workflow.run.start", undefined, {
      promptLength: prompt.length,
      maxTurns,
    });

    // Initialize once
    const initResult = (await step.do(
      "initialize",
      async (): Promise<any> => {
        return this.initializeWorkflow(sessionId, prompt);
      },
    )) as InitializedState;

    logTiming(this.env, sessionId, "workflow.initialize.step_do.done", workflowRunStart, {
      hasFirstStep: Boolean(initResult.firstStep),
      messageCount: initResult.session.messages.length,
    });

    if (!initResult.firstStep) {
      return this.finalizeWorkflow(sessionId, initResult.session, maxTurns, false);
    }

    let currentStep: NextStepInfo | undefined = initResult.firstStep;
    let currentSession = initResult.session;
    let turnCount = 0;

    while (currentStep && turnCount < maxTurns) {
      logTiming(this.env, sessionId, "workflow.step_do.start", undefined, {
        stepId: currentStep.stepId,
        stepType: currentStep.type,
        turnCount,
      });
      const stepDoStart = timingStart();
      const result = await step.do(
        currentStep.stepId,
        {
          retries: {
            limit: 3,
            delay: "5 seconds",
            backoff: "exponential",
          },
          timeout: "2 minutes",
        },
        async (): Promise<any> => {
          return this.executeStep(sessionId, currentStep!, turnCount);
        },
      );

      const stepResult = result as StepExecutionResult;
      logTiming(this.env, sessionId, "workflow.step_do.done", stepDoStart, {
        stepId: currentStep.stepId,
        stepType: currentStep.type,
        status: stepResult.status,
      });
      turnCount = stepResult.turnCount;

      // Reload session for next iteration
      currentSession = await loadSession(this.env, sessionId);

      // Check session status for next step
      const agent = createWorkflowAgent(await buildAgentComponents(this.env, this.ctx), this.env, sessionId);
      currentStep = agent.determineNextStep(currentSession);

      // Check for error status from session store
      const sessionState = await loadSessionState(this.env, sessionId);
      if (sessionState?.status === "error" || stepResult.status === "error") {
        break;
      }
    }

    const finalizeStart = timingStart();
    await step.do("finalize", async (): Promise<{ sessionId: string; status: string }> => {
      const loadedSession = await loadSession(this.env, sessionId);
      return this.finalizeWorkflow(sessionId, loadedSession, maxTurns, turnCount >= maxTurns);
    });
    logTiming(this.env, sessionId, "workflow.finalize.step_do.done", finalizeStart, {
      totalWorkflowElapsedMs: Date.now() - workflowRunStart,
    });

    return { sessionId, status: "completed" };
  }

  private async initializeWorkflow(
    sessionId: string,
    prompt: string,
  ): Promise<InitializedState> {
    const initStart = timingStart();
    logTiming(this.env, sessionId, "workflow.initialize.start", undefined, {
      promptLength: prompt.length,
    });

    const componentsStart = timingStart();
    const components = await buildAgentComponents(this.env, this.ctx);
    logTiming(this.env, sessionId, "workflow.initialize.components_built", componentsStart, {
      provider: components.model.provider,
      model: components.model.id,
      toolCount: components.tools.length,
    });

    const loadSessionStart = timingStart();
    const existingSession = await loadOrCreateSession(
      this.env,
      sessionId,
      components.model,
      getSystemPrompt(),
    );
    logTiming(this.env, sessionId, "workflow.initialize.session_loaded", loadSessionStart, {
      existingMessageCount: existingSession.messages.length,
    });

    const agent = createWorkflowAgent(components, this.env, sessionId);
    const initialized = agent.enqueuePrompt(existingSession, prompt);

    const saveSessionStart = timingStart();
    await saveSession(this.env, initialized.session);
    logTiming(this.env, sessionId, "workflow.initialize.workflow_session_saved", saveSessionStart);

    // Add timestamp to events and store in session
    const appendEventsStart = timingStart();
    const sessionEvents = initialized.events.map((e: AgentEvent) => ({ ...e, timestamp: Date.now() }));
    if (sessionEvents.length > 0) {
      await appendSessionEvents(this.env, sessionId, sessionEvents);
    }
    logTiming(this.env, sessionId, "workflow.initialize.events_appended", appendEventsStart, {
      eventCount: sessionEvents.length,
    });

    // Update session status
    const pollingStateStart = timingStart();
    let sessionState = await loadSessionState(this.env, sessionId);
    if (!sessionState) {
      sessionState = {
        id: sessionId,
        status: "processing" as const,
        messages: initialized.session.messages,
        
        nextEventCursor: "0",
        updatedAt: Date.now(),
      };
    } else {
      sessionState.status = "processing";
      sessionState.messages = initialized.session.messages;
      sessionState.updatedAt = Date.now();
    }
    await saveSessionState(this.env, sessionState);
    logTiming(this.env, sessionId, "workflow.initialize.polling_state_saved", pollingStateStart, {
      foundPollingState: true,
    });

    const firstStep = agent.determineNextStep(initialized.session);
    logTiming(this.env, sessionId, "workflow.initialize.done", initStart, {
      firstStepId: firstStep?.stepId,
      firstStepType: firstStep?.type,
    });

    return { session: initialized.session, firstStep };
  }

  private async executeStep(
    sessionId: string,
    stepInfo: NextStepInfo,
    currentTurn: number,
  ): Promise<StepExecutionResult> {
    const executeStart = timingStart();
    logTiming(this.env, sessionId, "workflow.execute_step.start", undefined, {
      stepId: stepInfo.stepId,
      stepType: stepInfo.type,
      currentTurn,
    });

    try {
      const componentsStart = timingStart();
      const components = await buildAgentComponents(this.env, this.ctx);
      logTiming(this.env, sessionId, "workflow.execute_step.components_built", componentsStart, {
        provider: components.model.provider,
        model: components.model.id,
        toolCount: components.tools.length,
      });
      const agent = createWorkflowAgent(components, this.env, sessionId);

      const loadStart = timingStart();
      const loadedSession = await loadSession(this.env, sessionId);
      logTiming(this.env, sessionId, "workflow.execute_step.session_loaded", loadStart, {
        messageCount: loadedSession.messages.length,
      });

      const runStepStart = timingStart();
      const stepResult = await agent.runSingleStep(
        loadedSession,
        stepInfo,
      );
      logTiming(this.env, sessionId, "workflow.execute_step.agent_step_done", runStepStart, {
        eventCount: stepResult.events.length,
        nextStepId: stepResult.nextStep?.stepId,
        nextStepType: stepResult.nextStep?.type,
        sessionStatus: stepResult.session.status,
      });

      // Add timestamp to events and store
      const appendEventsStart = timingStart();
      const sessionEvents = stepResult.events.map((e: AgentEvent) => ({ ...e, timestamp: Date.now() }));
      if (sessionEvents.length > 0) {
        await appendSessionEvents(this.env, sessionId, sessionEvents);
      }
      logTiming(this.env, sessionId, "workflow.execute_step.events_appended", appendEventsStart, {
        eventCount: sessionEvents.length,
      });

      // Calculate turn count from step ID
      const turnCount = this.extractTurnIndex(stepResult.nextStep?.stepId || "") || currentTurn;

      // Update session status based on result
      const pollingStateStart = timingStart();
      let sessionState = await loadSessionState(this.env, sessionId);
      if (!sessionState) {
        sessionState = {
          id: sessionId,
          status: stepResult.session.status === "error" ? "error" as const : "processing" as const,
          messages: stepResult.session.messages,
          
          nextEventCursor: "0",
          updatedAt: Date.now(),
          errorMessage: stepResult.session.errorMessage,
        };
      } else {
        sessionState.status = stepResult.session.status === "error" ? "error" : "processing";
        sessionState.messages = stepResult.session.messages;
        if (stepResult.session.errorMessage) {
          sessionState.errorMessage = stepResult.session.errorMessage;
        }
        sessionState.updatedAt = Date.now();
      }
      await saveSessionState(this.env, sessionState);
      logTiming(this.env, sessionId, "workflow.execute_step.polling_state_saved", pollingStateStart, {
        foundPollingState: true,
      });

      const saveSessionStart = timingStart();
      await saveSession(this.env, stepResult.session);
      logTiming(this.env, sessionId, "workflow.execute_step.workflow_session_saved", saveSessionStart);

      logTiming(this.env, sessionId, "workflow.execute_step.done", executeStart, {
        status: stepResult.session.status === "error" ? "error" : "processing",
      });

      return {
        sessionId,
        turnCount,
        status: stepResult.session.status === "error" ? "error" : "processing",
      };
    } catch (error) {
      logWorkflowStepException(this.env, sessionId, stepInfo, executeStart, error);
      throw error;
    }
  }

  private extractTurnIndex(stepId: string): number | undefined {
    const match = stepId.match(/^turn-(\d+)-/);
    return match ? parseInt(match[1]!, 10) : undefined;
  }

  private async finalizeWorkflow(
    sessionId: string,
    session: AgentSessionState,
    maxTurns: number,
    exceededMaxTurns: boolean,
  ): Promise<{ sessionId: string; status: string }> {
    const finalizeStart = timingStart();
    logTiming(this.env, sessionId, "workflow.finalize.start", undefined, {
      maxTurns,
      exceededMaxTurns,
      sessionStatus: session.status,
    });
    let nextSession = session;

    if (exceededMaxTurns && session.status !== "error") {
      const errorMessage = `Exceeded maximum turns (${maxTurns})`;
      nextSession = {
        ...session,
        status: "error",
        errorMessage,
        updatedAt: Date.now(),
      };
      const saveErrorStart = timingStart();
      await saveSession(this.env, nextSession);
      logTiming(this.env, sessionId, "workflow.finalize.error_session_saved", saveErrorStart);
    }

    // Write final state to session store
    const pollingStateStart = timingStart();
    let sessionState = await loadSessionState(this.env, sessionId);
    if (!sessionState) {
      sessionState = {
        id: sessionId,
        status: nextSession.status === "error" ? "error" : "idle",
        messages: nextSession.messages,
        
        nextEventCursor: "0",
        updatedAt: Date.now(),
        errorMessage: nextSession.errorMessage,
      };
    } else {
      sessionState.status = nextSession.status === "error" ? "error" : "idle";
      sessionState.messages = nextSession.messages;
      if (nextSession.errorMessage) {
        sessionState.errorMessage = nextSession.errorMessage;
      }
      sessionState.updatedAt = Date.now();
    }
    await saveSessionState(this.env, sessionState);
    logTiming(this.env, sessionId, "workflow.finalize.polling_state_saved", pollingStateStart, {
      foundPollingState: true,
      finalStatus: nextSession.status,
    });
    logTiming(this.env, sessionId, "workflow.finalize.done", finalizeStart);

    return { sessionId, status: nextSession.status };
  }
}

function logWorkflowException(env: Env, sessionId: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;

  console.error("[Workflow.run] Uncaught exception", {
    sessionId,
    message,
    stack,
  });

  logTiming(env, sessionId, "workflow.run.exception", undefined, {
    error: message,
    stack,
  });
}

function logWorkflowStepException(
  env: Env,
  sessionId: string,
  stepInfo: NextStepInfo,
  startedAt: number,
  error: unknown,
): void {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;

  console.error("[Workflow.executeStep] Step failed", {
    sessionId,
    stepId: stepInfo.stepId,
    stepType: stepInfo.type,
    message,
    stack,
  });

  logTiming(env, sessionId, "workflow.execute_step.exception", startedAt, {
    stepId: stepInfo.stepId,
    stepType: stepInfo.type,
    error: message,
    stack,
  });
}

function createWorkflowAgent(
  components: BuildAgentComponentsResult,
  env?: Env,
  sessionId?: string,
): Agent {
  return new Agent({
    model: components.model,
    tools: components.tools,
    streamFn: components.streamFn,
    getApiKey: components.getApiKey,
    systemPrompt: getSystemPrompt(),
    debugTiming: env
      ? (phase, startedAt, details) => logTiming(env, sessionId, phase, startedAt, details)
      : undefined,
    onEvent: env && sessionId
      ? createThrottledSessionEventWriter(env, sessionId)
      : undefined,
  });
}

function createThrottledSessionEventWriter(
  env: Env,
  sessionId: string,
): (event: AgentEvent) => Promise<void> {
  let lastMessageUpdateWrite = 0;

  return async (event: AgentEvent): Promise<void> => {
    if (!isAssistantStreamingEvent(event)) return;

    const now = Date.now();
    const shouldWrite = event.type !== "message_update" || now - lastMessageUpdateWrite >= 1000;
    if (!shouldWrite) return;

    if (event.type === "message_update") {
      lastMessageUpdateWrite = now;
    }

    try {
      await appendSessionEvents(env, sessionId, [{ ...event, timestamp: now }]);
    } catch (error) {
      console.error("[Workflow.liveEvents] Failed to append live event", {
        sessionId,
        eventType: event.type,
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
    }
  };
}

function isAssistantStreamingEvent(event: AgentEvent): boolean {
  return event.type === "message_start" ||
    event.type === "message_update" ||
    event.type === "message_end";
}

async function buildAgentComponents(
  env: Env,
  execCtx?: ExecutionContext,
): Promise<BuildAgentComponentsResult> {
  const { provider, model } = resolveConfiguredModel(env);
  const tools = createTools(env, execCtx);
  const useMock = shouldUseMockAI(env);

  const streamFn = useMock
    ? createMockStream()
    : provider === "amazon-bedrock"
      ? await createBedrockStreaming(env)
      : streamSimple;

  const getApiKey = (requestedProvider?: string): Promise<string | undefined> => {
    return Promise.resolve(getApiKeyForProvider(env, requestedProvider || provider));
  };

  return {
    model,
    tools,
    streamFn: streamFn as typeof streamSimple,
    getApiKey,
  };
}

async function loadOrCreateSession(
  env: Env,
  sessionId: string,
  model: BuildAgentComponentsResult["model"],
  systemPrompt: string,
): Promise<AgentSessionState> {
  try {
    return normalizeSession(await loadSession(env, sessionId), sessionId, model, systemPrompt);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("404")) throw error;
  }

  const session = createEmptyAgentSession({
    sessionId,
    model,
    systemPrompt,
  });

  await saveSession(env, session);
  return session;
}

function normalizeSession(
  value: Partial<AgentSessionState> & { messages?: AgentSessionState["messages"] },
  sessionId: string,
  model: BuildAgentComponentsResult["model"],
  systemPrompt: string,
): AgentSessionState {
  if (value.systemPrompt && value.model && value.turns && value.toolCalls) {
    return value as AgentSessionState;
  }

  return createEmptyAgentSession({
    sessionId,
    model,
    systemPrompt,
    messages: value.messages ?? [],
  });
}

export type { AgentSessionState };
