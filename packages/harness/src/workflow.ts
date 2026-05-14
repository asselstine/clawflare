// Clawflare Workflow Agent - durable, workflow-native agent execution.
// The Workflow owns the loop; Agent performs one replayable
// transition at a time: prompt, assistant step, tool step, complete turn.
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
  type AssistantStepResult,
  type CompleteTurnResult,
  type ToolStepResult,
} from "./agent";

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

interface WorkflowStepState {
  session: AgentSessionState;
  workflow: DurableAgentWorkflow;
}

type AssistantWorkflowStepResult = AssistantStepResult & { workflow: DurableAgentWorkflow };
type ToolWorkflowStepResult = ToolStepResult & { workflow: DurableAgentWorkflow };
type CompleteWorkflowStepResult = CompleteTurnResult & { workflow: DurableAgentWorkflow };

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

    let { session, workflow } = (await step.do("initialize", async (): Promise<any> => {
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

      return { session: initialized.session, workflow: nextWorkflow };
    })) as WorkflowStepState;

    while (workflow.status === "running" && workflow.turnCount < workflow.maxTurns) {
      const turnIndex = workflow.turnCount + 1;

      const assistantResult = (await step.do(
        `turn-${turnIndex}-assistant`,
        {
          retries: {
            limit: 3,
            delay: "5 seconds",
            backoff: "exponential",
          },
          timeout: "2 minutes",
        },
        async (): Promise<any> => {
          const components = await buildAgentComponents(this.env, this.ctx);
          const agent = createWorkflowAgent(components);

          const loadedSession = await loadSession(this.env, session.id);
          const loadedWorkflow = await loadWorkflow(this.env, workflow.id);

          const result = await agent.runAssistantStep(loadedSession);
          const nextWorkflow = appendAgentEvents(loadedWorkflow, result.events);
          await saveSession(this.env, result.session);
          await saveWorkflow(this.env, nextWorkflow);

          return { ...result, workflow: nextWorkflow };
        },
      )) as AssistantWorkflowStepResult;

      session = assistantResult.session;
      workflow = assistantResult.workflow;

      for (const toolCall of assistantResult.toolCalls) {
        const toolResult = (await step.do(
          `turn-${turnIndex}-tool-${safeStepName(toolCall.id)}`,
          {
            retries: {
              limit: 3,
              delay: "5 seconds",
              backoff: "exponential",
            },
            timeout: "2 minutes",
          },
          async (): Promise<any> => {
            const components = await buildAgentComponents(this.env, this.ctx);
            const agent = createWorkflowAgent(components);

            const loadedSession = await loadSession(this.env, session.id);
            const loadedWorkflow = await loadWorkflow(this.env, workflow.id);

            const result = await agent.runToolStep(loadedSession, toolCall.id);
            const nextWorkflow = appendAgentEvents(loadedWorkflow, result.events);
            await saveSession(this.env, result.session);
            await saveWorkflow(this.env, nextWorkflow);

            return { ...result, workflow: nextWorkflow };
          },
        )) as ToolWorkflowStepResult;

        session = toolResult.session;
        workflow = toolResult.workflow;
      }

      const completion = (await step.do(`turn-${turnIndex}-complete`, async (): Promise<any> => {
        const components = await buildAgentComponents(this.env, this.ctx);
        const agent = createWorkflowAgent(components);

        const loadedSession = await loadSession(this.env, session.id);
        const loadedWorkflow = await loadWorkflow(this.env, workflow.id);

        const result = agent.completeTurn(loadedSession);
        let nextWorkflow = appendAgentEvents(loadedWorkflow, result.events);
        nextWorkflow = updateWorkflowAfterTurn(nextWorkflow, result);
        await saveSession(this.env, result.session);
        await saveWorkflow(this.env, nextWorkflow);

        return { ...result, workflow: nextWorkflow };
      })) as CompleteWorkflowStepResult;

      session = completion.session;
      workflow = completion.workflow;

      if (completion.shouldStop) break;
    }

    const finalWorkflow = (await step.do("finalize", async (): Promise<any> => {
      const loadedSession = await loadSession(this.env, session.id);
      const loadedWorkflow = await loadWorkflow(this.env, workflow.id);

      let nextWorkflow = loadedWorkflow;
      let nextSession = loadedSession;

      if (nextWorkflow.turnCount >= nextWorkflow.maxTurns && nextWorkflow.status === "running") {
        nextWorkflow = {
          ...nextWorkflow,
          status: "error",
          errorMessage: `Exceeded maximum turns (${nextWorkflow.maxTurns})`,
        };
        nextWorkflow = appendWorkflowProgress(nextWorkflow, {
          type: "error",
          summary: nextWorkflow.errorMessage!,
        });
        nextSession = {
          ...nextSession,
          status: "error",
          errorMessage: nextWorkflow.errorMessage,
          updatedAt: Date.now(),
        };
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

      await saveSession(this.env, nextSession);
      await saveWorkflow(this.env, nextWorkflow);

      return nextWorkflow;
    })) as DurableAgentWorkflow;

    return finalWorkflow;
  }
}

function appendWorkflowProgress(
  workflow: DurableAgentWorkflow,
  event: Omit<WorkflowProgressEvent, "timestamp" | "sequence">,
): DurableAgentWorkflow {
  const sequence = (workflow.progress.at(-1)?.sequence ?? 0) + 1;
  return {
    ...workflow,
    progress: [...workflow.progress, { ...event, timestamp: Date.now(), sequence }].slice(-100),
  };
}

function appendAgentEvents(
  workflow: DurableAgentWorkflow,
  events: AgentEvent[],
): DurableAgentWorkflow {
  return events.reduce(
    (nextWorkflow, event) => appendWorkflowProgress(nextWorkflow, summarizeAgentEvent(event)),
    workflow,
  );
}

function summarizeAgentEvent(event: AgentEvent): Omit<WorkflowProgressEvent, "timestamp" | "sequence"> {
  const type = event.type.startsWith("tool_")
    ? "tool"
    : event.type.startsWith("message_")
      ? "message"
      : event.type.startsWith("turn_")
        ? "turn"
        : event.type.startsWith("agent_")
          ? "agent"
          : "workflow";

  return { type, summary: agentEventSummary(event), event };
}

function agentEventSummary(event: AgentEvent): string {
  switch (event.type) {
    case "agent_start":
      return "Agent run started";
    case "agent_end":
      return "Agent run completed";
    case "turn_start":
      return "Turn started";
    case "turn_end":
      return "Turn completed";
    case "message_start":
      return `${event.message.role} message started`;
    case "message_update":
      return `${event.message.role} message updated`;
    case "message_end":
      return `${event.message.role} message recorded`;
    case "tool_execution_start":
      return `Running ${event.toolName}`;
    case "tool_execution_update":
      return `${event.toolName} updated`;
    case "tool_execution_end":
      return `${event.toolName} ${event.isError ? "failed" : "completed"}`;
  }
}

function updateWorkflowAfterTurn(
  workflow: DurableAgentWorkflow,
  result: CompleteTurnResult,
): DurableAgentWorkflow {
  if (result.session.status === "error") {
    return appendWorkflowProgress(
      {
        ...workflow,
        turnCount: result.completedTurnIndex,
        status: "error",
        errorMessage: result.session.errorMessage,
      },
      {
        type: "error",
        summary: result.session.errorMessage || "Assistant turn failed",
      },
    );
  }

  if (result.shouldStop) {
    return {
      ...workflow,
      turnCount: result.completedTurnIndex,
      status: "idle",
    };
  }

  return {
    ...workflow,
    turnCount: result.completedTurnIndex,
  };
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

async function loadSession(env: Env, sessionId: string): Promise<AgentSessionState> {
  const raw = await env.AGENT_SESSION.get(sessionKey(sessionId));
  if (!raw) throw new Error(`Session not found: ${sessionId}`);
  return JSON.parse(raw) as AgentSessionState;
}

async function loadWorkflow(env: Env, workflowId: string): Promise<DurableAgentWorkflow> {
  const raw = await env.AGENT_SESSION.get(workflowKey(workflowId));
  if (!raw) throw new Error(`Workflow not found: ${workflowId}`);
  return JSON.parse(raw) as DurableAgentWorkflow;
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

async function saveSession(env: Env, session: AgentSessionState): Promise<void> {
  const serialized = JSON.stringify({
    ...session,
    updatedAt: Date.now(),
  });
  await env.AGENT_SESSION.put(sessionKey(session.id), serialized);
  // Keep the historic unprefixed context key readable by /v1/context and older clients.
  await env.AGENT_SESSION.put(session.id, serialized);
}

async function saveWorkflow(env: Env, workflow: DurableAgentWorkflow): Promise<void> {
  await env.AGENT_SESSION.put(workflowKey(workflow.id), JSON.stringify(workflow));
}

function sessionKey(sessionId: string): string {
  return `session:${sessionId}`;
}

function workflowKey(workflowId: string): string {
  return `workflow:${workflowId}`;
}

function safeStepName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
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
