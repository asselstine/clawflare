// Clawflare Workflow Agent - durable, workflow-native agent execution.
// The Workflow owns persistence; Agent decides what steps to run.
import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from "cloudflare:workers";
import type { Env, ChatRequest, ChatResponse } from "./types";
import { createTools } from "./tools";
import { createMockStream, shouldUseMockAI } from "./mock-ai";
import { streamSimple } from "@earendil-works/pi-ai";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
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
  type RunStepResult,
} from "./agent";
import {
  sessionKey,
  workflowKey,
  loadSession,
  saveSession,
  loadWorkflow,
  saveWorkflow,
  appendAgentEvents,
  appendWorkflowProgress,
} from "./workflow-state";

export interface WorkflowProgressEvent {
  timestamp: number;
  sequence: number;
  type: "workflow" | "agent" | "turn" | "message" | "tool" | "error";
  summary: string;
  event?: AgentEvent;
}

export interface DurableAgentWorkflow {
  id: string;
  sessionId: string;
  status: "running" | "idle" | "error" | "awaiting_input";
  turnCount: number;
  maxTurns: number;
  progress: WorkflowProgressEvent[];
  errorMessage?: string;
}

interface WorkflowInput {
  sessionId: string;
  prompt: string;
  maxTurns?: number;
}

export interface WorkflowStartedResponse {
  type: "workflow_started";
  id: string;
  workflowId: string;
  instanceId: string;
  sessionId: string;
  status: "running";
  pollUrl: string;
}

export interface WorkflowStatusResponse {
  status: "running" | "success" | "errored" | "paused";
  state?: DurableAgentWorkflow;
  session?: AgentSessionState;
  currentStep?: string;
  response?: ChatResponse;
}

interface InitializedState {
  session: AgentSessionState;
  workflow: DurableAgentWorkflow;
  firstStep?: NextStepInfo;
}

interface StepExecutionResult {
  session: AgentSessionState;
  workflow: DurableAgentWorkflow;
  nextStep?: NextStepInfo;
}

const DEFAULT_MAX_TURNS = 20;

export async function startAgentWorkflow(
  env: Env,
  request: ChatRequest,
): Promise<WorkflowStartedResponse> {
  if (request.type !== "prompt" || !request.content) {
    throw new Error("Invalid request. type='prompt' and content required");
  }

  const sessionId = request.sessionId || crypto.randomUUID();
  const workflowId = crypto.randomUUID();
  const maxTurns = request.maxTurns ?? DEFAULT_MAX_TURNS;

  const placeholder: DurableAgentWorkflow = {
    id: workflowId,
    sessionId,
    status: "running",
    turnCount: 0,
    maxTurns,
    progress: [
      {
        timestamp: Date.now(),
        sequence: 1,
        type: "workflow",
        summary: "Workflow queued",
      },
    ],
  };

  // Write a placeholder before create() returns so immediate polls don't race
  // the Workflow's initialize step.
  await saveWorkflow(env, placeholder);

  const instance = await env.AGENT_WORKFLOW.create({
    id: workflowId,
    params: {
      sessionId,
      prompt: request.content,
      maxTurns,
    },
  });

  return {
    type: "workflow_started",
    id: instance.id,
    workflowId: instance.id,
    instanceId: instance.id,
    sessionId,
    status: "running",
    pollUrl: `/v1/workflow/${instance.id}`,
  };
}

export class Workflow extends WorkflowEntrypoint<Env, WorkflowInput> {
  async run(event: WorkflowEvent<WorkflowInput>, step: WorkflowStep) {
    const { sessionId, prompt, maxTurns = DEFAULT_MAX_TURNS } = event.payload;
    const workflowId = event.instanceId;

    // Initialize once
    const initResult = (await step.do(
      "initialize",
      async (): Promise<any> => {
        return this.initializeWorkflow(sessionId, prompt, workflowId, maxTurns);
      },
    )) as InitializedState;

    // Early exit if no work to do (shouldn't happen in practice)
    if (!initResult.firstStep) {
      return this.finalizeWorkflow(initResult.workflow, false);
    }

    // Main execution loop - Workflow knows NOTHING about step internals
    let currentStep: NextStepInfo | undefined = initResult.firstStep;
    let currentSession = initResult.session;
    let currentWorkflow = initResult.workflow;
    let stepCount = 0;

    while (currentStep && currentWorkflow.turnCount < currentWorkflow.maxTurns) {
      stepCount++;

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
          return this.executeStep(currentSession, currentWorkflow, currentStep!);
        },
      );

      const stepResult = result as StepExecutionResult;
      currentSession = stepResult.session;
      currentWorkflow = stepResult.workflow;
      currentStep = stepResult.nextStep;;

      // Exit on error
      if (currentWorkflow.status === "error") {
        break;
      }
    }

    // Finalize
    const finalWorkflow = await step.do("finalize", async (): Promise<DurableAgentWorkflow> => {
      const loadedWorkflow = await loadWorkflow(this.env, currentWorkflow.id);
      return this.finalizeWorkflow(
        loadedWorkflow,
        currentWorkflow.turnCount >= maxTurns && loadedWorkflow.status === "running",
      );
    });

    return finalWorkflow;
  }

  private async initializeWorkflow(
    sessionId: string,
    prompt: string,
    workflowId: string,
    maxTurns: number,
  ): Promise<InitializedState> {
    const components = await buildAgentComponents(this.env, this.ctx);
    const existingSession = await loadOrCreateSession(
      this.env,
      sessionId,
      components.model,
      getSystemPrompt(),
    );

    const workflow: DurableAgentWorkflow = {
      id: workflowId,
      sessionId,
      status: "running",
      turnCount: 0,
      maxTurns,
      progress: [
        {
          timestamp: Date.now(),
          sequence: 1,
          type: "workflow",
          summary: "Workflow initialized",
        },
      ],
    };

    const agent = createWorkflowAgent(components);
    const initialized = agent.enqueuePrompt(existingSession, prompt);
    const nextWorkflow = appendAgentEvents(workflow, initialized.events);

    await saveSession(this.env, initialized.session);
    await saveWorkflow(this.env, nextWorkflow);

    // Let the agent determine what step to run next
    const firstStep = agent.determineNextStep(initialized.session);

    return { session: initialized.session, workflow: nextWorkflow, firstStep };
  }

  private async executeStep(
    session: AgentSessionState,
    workflow: DurableAgentWorkflow,
    stepInfo: NextStepInfo,
  ): Promise<StepExecutionResult> {
    const components = await buildAgentComponents(this.env, this.ctx);
    const agent = createWorkflowAgent(components);

    const [loadedSession, loadedWorkflow] = await Promise.all([
      loadSession(this.env, session.id),
      loadWorkflow(this.env, workflow.id),
    ]);

    // Single call to Agent - it decides what happens
    const stepResult = await agent.runSingleStep(loadedSession, stepInfo);

    // Apply agent events to workflow
    let nextWorkflow = appendAgentEvents(loadedWorkflow, stepResult.events);

    // Update workflow state based on step result
    nextWorkflow = this.updateWorkflowAfterStep(nextWorkflow, stepResult);

    await saveSession(this.env, stepResult.session);
    await saveWorkflow(this.env, nextWorkflow);

    return {
      session: stepResult.session,
      workflow: nextWorkflow,
      nextStep: stepResult.nextStep,
    };
  }

  private updateWorkflowAfterStep(
    workflow: DurableAgentWorkflow,
    result: RunStepResult,
  ): DurableAgentWorkflow {
    // Update turn count on complete steps
    if (result.nextStep?.type === "assistant") {
      // Check if this completed a turn and we're starting a new one
      const currentTurn = workflow.turnCount;
      const completedTurnIndex = this.extractTurnIndex(result.nextStep.stepId);
      if (completedTurnIndex && completedTurnIndex > currentTurn) {
        return { ...workflow, turnCount: completedTurnIndex };
      }
    }

    // Handle error state
    if (result.session.status === "error") {
      return {
        ...workflow,
        status: "error",
        errorMessage: result.session.errorMessage || "Agent error",
      };
    }

    return workflow;
  }

  private extractTurnIndex(stepId: string): number | undefined {
    const match = stepId.match(/^turn-(\d+)-/);
    return match ? parseInt(match[1]!, 10) : undefined;
  }

  private async finalizeWorkflow(
    workflow: DurableAgentWorkflow,
    exceededMaxTurns: boolean,
  ): Promise<DurableAgentWorkflow> {
    let nextWorkflow = workflow;
    let nextSession: AgentSessionState | undefined;

    // Load session if we might need to update it
    try {
      nextSession = await loadSession(this.env, workflow.sessionId);
    } catch {
      // Session might not exist in edge cases
    }

    if (exceededMaxTurns && workflow.status === "running") {
      const errorMessage = `Exceeded maximum turns (${workflow.maxTurns})`;
      nextWorkflow = {
        ...nextWorkflow,
        status: "error",
        errorMessage,
      };
      nextWorkflow = appendWorkflowProgress(nextWorkflow, {
        type: "error",
        summary: errorMessage,
      });

      if (nextSession) {
        nextSession = {
          ...nextSession,
          status: "error",
          errorMessage,
          updatedAt: Date.now(),
        };
        await saveSession(this.env, nextSession);
      }
    }

    if (nextWorkflow.status === "running") {
      nextWorkflow = appendWorkflowProgress(
        { ...nextWorkflow, status: "idle" },
        {
          type: "workflow",
          summary: "Workflow completed",
        },
      );
    }

    await saveWorkflow(this.env, nextWorkflow);
    return nextWorkflow;
  }
}

function createWorkflowAgent(components: BuildAgentComponentsResult): Agent {
  return new Agent({
    model: components.model,
    tools: components.tools,
    streamFn: components.streamFn,
    getApiKey: components.getApiKey,
    systemPrompt: getSystemPrompt(),
  });
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
  const existing = await env.AGENT_SESSION.get(sessionKey(sessionId));
  if (existing) return normalizeSession(JSON.parse(existing), sessionId, model, systemPrompt);

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

export async function getWorkflowStatus(
  env: Env,
  workflowId: string,
): Promise<WorkflowStatusResponse> {
  const workflowRaw = await env.AGENT_SESSION.get(workflowKey(workflowId));

  if (!workflowRaw) {
    return {
      status: "errored",
      currentStep: "workflow_not_found",
      response: {
        type: "error",
        content: `Workflow not found: ${workflowId}`,
      },
    };
  }

  const workflow = JSON.parse(workflowRaw) as DurableAgentWorkflow;
  workflow.progress ||= [];

  const sessionRaw = await env.AGENT_SESSION.get(sessionKey(workflow.sessionId));
  const session = sessionRaw ? (JSON.parse(sessionRaw) as AgentSessionState) : undefined;

  const status =
    workflow.status === "running"
      ? "running"
      : workflow.status === "error"
        ? "errored"
        : "success";

  return {
    status,
    state: workflow,
    session,
    currentStep: `turn-${workflow.turnCount + 1}`,
    response: status === "running" ? undefined : extractWorkflowResponse(workflow, session, status),
  };
}

function extractWorkflowResponse(
  workflow: DurableAgentWorkflow,
  session: AgentSessionState | undefined,
  status: Exclude<WorkflowStatusResponse["status"], "running" | "paused">,
): ChatResponse {
  if (status === "errored") {
    return {
      type: "error",
      content: workflow.errorMessage || session?.errorMessage || "Workflow failed",
      sessionId: workflow.sessionId,
    };
  }

  const lastAssistant = session?.messages
    .slice()
    .reverse()
    .find((message): message is Extract<typeof message, { role: "assistant" }> =>
      message.role === "assistant",
    );

  const content =
    lastAssistant && Array.isArray(lastAssistant.content)
      ? lastAssistant.content
          .filter((item): item is { type: "text"; text: string } => item.type === "text")
          .map((item) => item.text)
          .join("")
      : "";

  return {
    type: "message",
    content: content || "(No response received)",
    sessionId: workflow.sessionId,
    messages: session?.messages,
    usage: lastAssistant?.usage,
  };
}

export type { AgentSessionState };
