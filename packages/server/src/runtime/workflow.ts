import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { Env } from "../internal-types/index.js";
import {
  SessionEventRepository,
  SessionMessageRepository,
  SessionRepository,
  SessionRunRepository,
  SessionRuntimeRepository,
  type SessionRun,
  type SessionInputEvent,
} from "../data/index.js";
import { Agent, createEmptyAgentSession, type AgentSessionState, type NextStepInfo } from "./agent.js";
import { buildAgentComponents, buildAgentComponentsFromResolved, type BuildAgentComponentsResult } from "./agent-config.js";
import { LiveAgentEventPersister } from "./live-event-persister.js";
import { createMockStream, shouldUseMockAI } from "./mock-ai.js";
import {
  createBuiltinToolRuntimeContext,
  loadBuiltinToolsByRefs,
  loadSessionBuiltinToolRefs,
} from "../modules/tools/tools.service.js";
import {
  collectTiming,
  flushTimingCollector,
  logTiming,
  TimingCollector,
  timingStart,
} from "../lib/timing.js";
import { logger, errorMessage } from "../lib/logger.js";
import {
  resolveModel,
  resolveModelForSession,
  type ResolvedModel,
} from "../modules/models/models.service.js";
import {
  appendSessionStatusEvent,
  projectAndAppendAgentEvents,
} from "./message-projection.js";

const DEFAULT_SYSTEM_PROMPT = `You are Clawflare, an AI agent running as a web service. Your core tools allow you to execute code, and egress handlers can afford authorized fetches from external HTTP APIs and supported HTTPS protocol endpoints such as native Git smart HTTP. Before saying you lack access to an external service, account, resource, profile, API, or HTTPS git remote, inspect the configured egress handlers with your search tool. Treat enabled, configured egress handlers as available authenticated routes for matching domains; treat unavailable or disabled handlers as not currently usable. If an authenticated request reaches the service but receives a 401 or 403, report that the configured credential was rejected or lacks permission instead of claiming no credential path exists. When using code execution tools, provide JavaScript as an ES module with a default exported async function: export default async function(input, env) { ... }. Return values or write to console.log for any output that should be visible; do not infer or invent results that are absent from tool output.

When using container_bash, do not specify the timeoutMs parameter unless you specifically need a shorter timeout than the default 30 minutes. Let the system use its default timeout. Do not guess or make up timeouts. If you need longer than 30 minutes, you may specify up to 60 minutes (3600000ms).

When referencing files in a container, you may emit markdown links whose URL protocol is the container ID and whose path is the file path, for example [src/index.ts](container-id:/workspace/src/index.ts). Clawflare clients can recognize these links and open the file in the matching container workspace.`;

type JsonValue = null | string | number | boolean | JsonValue[] | { [key: string]: JsonValue };

interface StoredWorkflowSession {
  messages?: AgentMessage[];
}

interface WorkflowAgentContext {
  workspaceId: string;
  resolvedModel: ResolvedModel | null;
  components: BuildAgentComponentsResult;
  mockAI: boolean;
  hotContext?: WorkflowHotContext;
}

interface WorkflowHotContext {
  workspaceId: string;
  modelId?: string | null;
  resolvedModel: ResolvedModel | null;
  toolRefs?: string[];
  cachedAt: number;
}

interface LoadedAgentSession {
  session: AgentSessionState;
  agentContext?: WorkflowAgentContext;
}

type WorkflowTimingLog = (
  phase: string,
  startedAt?: number,
  details?: Record<string, unknown>,
) => void;

function promptApiTimingDetails(input: Extract<SessionInputEvent, { type: "prompt" }>): Record<string, unknown> {
  if (!input.apiReceivedAt) return {};
  return {
    apiRequestId: input.apiRequestId,
    apiReceivedAt: input.apiReceivedAt,
    apiElapsedMs: Date.now() - input.apiReceivedAt,
  };
}

function createWorkflowTiming(env: Env, sessionId: string, collector: TimingCollector): WorkflowTimingLog {
  return (phase, startedAt, details) => collectTiming(env, collector, sessionId, phase, startedAt, details);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function isResolvedModel(value: unknown): value is ResolvedModel {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.provider === "string" &&
    typeof value.modelName === "string" &&
    isStringRecord(value.secrets) &&
    isRecord(value.config)
  );
}

function isWorkflowHotContext(value: unknown): value is WorkflowHotContext {
  return (
    isRecord(value) &&
    typeof value.workspaceId === "string" &&
    (value.modelId === undefined || value.modelId === null || typeof value.modelId === "string") &&
    (value.resolvedModel === null || isResolvedModel(value.resolvedModel)) &&
    (value.toolRefs === undefined || (Array.isArray(value.toolRefs) && value.toolRefs.every((toolRef) => typeof toolRef === "string"))) &&
    typeof value.cachedAt === "number"
  );
}

async function getWorkflowHotContext(
  runtime: SessionRuntimeRepository,
  sessionId: string,
  timing?: WorkflowTimingLog,
): Promise<unknown | null> {
  try {
    return await runtime.getHotContext(sessionId);
  } catch (error) {
    timing?.("workflow.agent_context.cache_unavailable", undefined, {
      operation: "get",
      error: errorMessage(error),
    });
    return null;
  }
}

async function saveWorkflowHotContext(
  runtime: SessionRuntimeRepository,
  sessionId: string,
  hotContext: WorkflowHotContext,
  timing?: WorkflowTimingLog,
): Promise<boolean> {
  try {
    await runtime.saveHotContext(sessionId, hotContext);
    return true;
  } catch (error) {
    timing?.("workflow.agent_context.cache_unavailable", undefined, {
      operation: "save",
      error: errorMessage(error),
    });
    return false;
  }
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
    (value.toolCallId === undefined || typeof value.toolCallId === "string") &&
    (
      value.toolCallIds === undefined ||
      (Array.isArray(value.toolCallIds) && value.toolCallIds.every((toolCallId) => typeof toolCallId === "string"))
    )
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
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function deserializeForWorkflow(serializedJson: string): JsonValue {
  return JSON.parse(serializedJson) as JsonValue;
}

async function appendAgentEvents(
  env: Env,
  eventsRepo: SessionEventRepository,
  messagesRepo: SessionMessageRepository,
  sessionId: string,
  events: AgentEvent[],
  workspaceId?: string,
  timing?: WorkflowTimingLog,
): Promise<void> {
  if (events.length === 0) return;
  const appendStart = timingStart();
  await projectAndAppendAgentEvents(eventsRepo, messagesRepo, sessionId, events, { workspaceId });
  (timing ?? ((phase, startedAt, details) => logTiming(env, sessionId, phase, startedAt, details)))("workflow.events.appended", appendStart, {
    eventCount: events.length,
    eventTypes: events.map((event) => event.type),
  });
}

async function appendErrorEvent(
  eventsRepo: SessionEventRepository,
  sessionId: string,
  message: string,
): Promise<void> {
  await appendSessionStatusEvent(eventsRepo, sessionId, {
    type: "session.status_changed",
    status: "error",
    errorMessage: message,
  });
}

async function createWorkflowAgentContext(
  env: Env,
  sessionId: string,
  timing?: WorkflowTimingLog,
): Promise<WorkflowAgentContext> {
  const contextStart = timingStart();
  const runtime = new SessionRuntimeRepository(env.DB);
  const cachedStart = timingStart();
  const cached = await getWorkflowHotContext(runtime, sessionId, timing);
  if (isWorkflowHotContext(cached)) {
    const componentsStart = timingStart();
    const components = cached.resolvedModel
      ? await buildAgentComponentsFromResolved(cached.resolvedModel)
      : await buildAgentComponents();
    const mockAI = shouldUseMockAI(env);
    (timing ?? ((phase, startedAt, details) => logTiming(env, sessionId, phase, startedAt, details)))("workflow.agent_context.cache_hit", cachedStart, {
      workspaceId: cached.workspaceId,
      modelId: cached.modelId,
      provider: cached.resolvedModel?.provider,
      modelName: cached.resolvedModel?.modelName,
      toolRefCount: cached.toolRefs?.length,
      ageMs: Date.now() - cached.cachedAt,
    });
    (timing ?? ((phase, startedAt, details) => logTiming(env, sessionId, phase, startedAt, details)))("workflow.agent_context.components_built", componentsStart, {
      model: components.model.id,
      provider: components.model.provider,
      cacheHit: true,
    });
    (timing ?? ((phase, startedAt, details) => logTiming(env, sessionId, phase, startedAt, details)))("workflow.agent_context.created", contextStart, {
      model: components.model.id,
      provider: components.model.provider,
      mockAI,
      workspaceId: cached.workspaceId,
      modelId: cached.modelId,
      cacheHit: true,
    });

    return {
      workspaceId: cached.workspaceId,
      resolvedModel: cached.resolvedModel,
      components,
      mockAI,
      hotContext: cached,
    };
  }

  (timing ?? ((phase, startedAt, details) => logTiming(env, sessionId, phase, startedAt, details)))("workflow.agent_context.cache_miss", cachedStart, {
    hasCachedContext: Boolean(cached),
  });

  const sessions = new SessionRepository(env.DB);
  const sessionStart = timingStart();
  const session = await sessions.findById(sessionId);
  (timing ?? ((phase, startedAt, details) => logTiming(env, sessionId, phase, startedAt, details)))("workflow.agent_context.session_loaded", sessionStart, {
    found: Boolean(session),
    workspaceId: session?.workspaceId,
    modelId: session?.modelId,
  });
  const workspaceId = session?.workspaceId ?? "default-workspace";

  const modelStart = timingStart();
  const resolvedModel = session?.modelId
    ? await resolveModel(env, workspaceId, session.modelId, {
        type: "session",
        sessionId,
      })
    : await resolveModelForSession(env, sessionId, {
        type: "session",
        sessionId,
      });
  (timing ?? ((phase, startedAt, details) => logTiming(env, sessionId, phase, startedAt, details)))("workflow.agent_context.model_resolved", modelStart, {
    workspaceId,
    modelId: resolvedModel?.id,
    provider: resolvedModel?.provider,
    modelName: resolvedModel?.modelName,
  });

  const componentsStart = timingStart();
  const components = resolvedModel
    ? await buildAgentComponentsFromResolved(resolvedModel)
    : await buildAgentComponents();
  (timing ?? ((phase, startedAt, details) => logTiming(env, sessionId, phase, startedAt, details)))("workflow.agent_context.components_built", componentsStart, {
    model: components.model.id,
    provider: components.model.provider,
  });

  const mockAI = shouldUseMockAI(env);

  (timing ?? ((phase, startedAt, details) => logTiming(env, sessionId, phase, startedAt, details)))("workflow.agent_context.created", contextStart, {
    model: components.model.id,
    provider: components.model.provider,
    mockAI,
    workspaceId,
    modelId: resolvedModel?.id,
    cacheHit: false,
  });

  const hotContext: WorkflowHotContext = {
    workspaceId,
    modelId: resolvedModel?.id ?? null,
    resolvedModel,
    cachedAt: Date.now(),
  };
  const cacheSaveStart = timingStart();
  const cacheSaved = await saveWorkflowHotContext(runtime, sessionId, hotContext, timing);
  (timing ?? ((phase, startedAt, details) => logTiming(env, sessionId, phase, startedAt, details)))("workflow.agent_context.cache_saved", cacheSaveStart, {
    workspaceId,
    modelId: resolvedModel?.id,
    written: cacheSaved,
  });

  return {
    workspaceId,
    resolvedModel,
    components,
    mockAI,
    hotContext,
  };
}

async function createWorkflowAgent(
  env: Env,
  ctx: ExecutionContext | undefined,
  sessionId: string,
  onEvent?: (event: AgentEvent) => void | Promise<void>,
  agentContext?: WorkflowAgentContext,
  timing?: WorkflowTimingLog,
  extraTimingDetails?: () => Record<string, unknown>,
): Promise<Agent> {
  const componentsStart = timingStart();
  const preparedContext = agentContext ?? await createWorkflowAgentContext(env, sessionId, timing);
  const { components, workspaceId, resolvedModel, mockAI } = preparedContext;
  const streamFn = mockAI ? createMockStream() : components.streamFn;
  
  const toolsStart = timingStart();
  const cachedToolRefs = preparedContext.hotContext?.toolRefs;
  const toolRefs = cachedToolRefs ?? await loadSessionBuiltinToolRefs(env, sessionId);
  const tools = loadBuiltinToolsByRefs(toolRefs);
  if (!cachedToolRefs) {
    const runtime = new SessionRuntimeRepository(env.DB);
    const hotContext: WorkflowHotContext = {
      ...(preparedContext.hotContext ?? {
        workspaceId,
        modelId: resolvedModel?.id ?? null,
        resolvedModel,
      }),
      toolRefs,
      cachedAt: preparedContext.hotContext?.cachedAt ?? Date.now(),
    };
    await saveWorkflowHotContext(runtime, sessionId, hotContext, timing);
    preparedContext.hotContext = {
      ...(preparedContext.hotContext ?? {
        workspaceId,
        modelId: resolvedModel?.id ?? null,
        resolvedModel,
        cachedAt: Date.now(),
      }),
      toolRefs,
    };
  }
  (timing ?? ((phase, startedAt, details) => logTiming(env, sessionId, phase, startedAt, details)))("workflow.agent.tools_loaded", toolsStart, {
    toolCount: tools.length,
    toolRefCount: toolRefs.length,
    cacheHit: Boolean(cachedToolRefs),
  });
  
  (timing ?? ((phase, startedAt, details) => logTiming(env, sessionId, phase, startedAt, details)))("workflow.agent.created", componentsStart, {
    model: components.model.id,
    provider: components.model.provider,
    toolCount: tools.length,
    mockAI,
    workspaceId,
    modelId: resolvedModel?.id,
    ...(extraTimingDetails?.() ?? {}),
  });

  return new Agent({
    model: components.model,
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    tools,
    toolRuntimeContext: createBuiltinToolRuntimeContext({
      env,
      ctx,
      toolCtx: { sessionId, workspaceId },
    }),
    streamFn,
    getApiKey: () => components.getApiKey(),
    debugTiming: (phase, startedAt, details) => (timing ?? ((timingPhase, timingStartedAt, timingDetails) =>
      logTiming(env, sessionId, timingPhase, timingStartedAt, timingDetails)
    ))(`agent.${phase}`, startedAt, {
      ...(details ?? {}),
      ...(extraTimingDetails?.() ?? {}),
    }),
    onEvent,
  });
}

async function loadAgentSession(
  env: Env,
  sessionId: string,
  agentContext?: WorkflowAgentContext,
  timing?: WorkflowTimingLog,
): Promise<LoadedAgentSession> {
  const runtime = new SessionRuntimeRepository(env.DB);
  const loadStart = timingStart();
  const stored = await runtime.getWorkflowSession(sessionId);

  (timing ?? ((phase, startedAt, details) => logTiming(env, sessionId, phase, startedAt, details)))("workflow.session.loaded", loadStart, {
    hasStoredSession: Boolean(stored),
    storedSessionValid: isAgentSessionState(stored),
    usedAgentContext: Boolean(agentContext),
    modelId: agentContext?.resolvedModel?.id,
  });

  if (isAgentSessionState(stored)) {
    return { session: stored };
  }

  const context = agentContext ?? await createWorkflowAgentContext(env, sessionId, timing);

  const messages = isRecord(stored) && Array.isArray((stored as StoredWorkflowSession).messages)
    ? [...(stored as StoredWorkflowSession).messages!]
    : [];

  return {
    session: createEmptyAgentSession({
      sessionId,
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      model: context.components.model,
      messages,
    }),
    agentContext: context,
  };
}

async function saveSessionMetadata(
  env: Env,
  sessions: SessionRepository,
  runtime: SessionRuntimeRepository,
  events: SessionEventRepository,
  sessionId: string,
  status: "processing" | "idle" | "error",
  errorMessage?: string,
  timing?: WorkflowTimingLog,
): Promise<void> {
  // Get existing session to preserve workspaceId
  const sessionStart = timingStart();
  const existingSession = await sessions.findById(sessionId);
  (timing ?? ((phase, startedAt, details) => logTiming(env, sessionId, phase, startedAt, details)))("workflow.metadata.session_loaded", sessionStart, {
    status,
    found: Boolean(existingSession),
    workspaceId: existingSession?.workspaceId,
  });
  const workflowIdStart = timingStart();
  const workflowId = (await runtime.getWorkflowId(sessionId)) ?? "";
  (timing ?? ((phase, startedAt, details) => logTiming(env, sessionId, phase, startedAt, details)))("workflow.metadata.workflow_id_loaded", workflowIdStart, {
    status,
    hasWorkflowId: Boolean(workflowId),
  });
  const cursorStart = timingStart();
  const nextEventCursor = await events.latestCursor(sessionId);
  (timing ?? ((phase, startedAt, details) => logTiming(env, sessionId, phase, startedAt, details)))("workflow.metadata.cursor_loaded", cursorStart, {
    status,
    nextEventCursor,
  });
  
  const saveStart = timingStart();
  await sessions.save({
    id: sessionId,
    workspaceId: existingSession?.workspaceId ?? "default-workspace",
    workflowId,
    status,
    nextEventCursor,
    updatedAt: Date.now(),
    errorMessage: status === "error" ? errorMessage : undefined,
    maxQueueSize: existingSession?.maxQueueSize ?? 100,
    idleTimeout: existingSession?.idleTimeout ?? "7 days",
  });
  (timing ?? ((phase, startedAt, details) => logTiming(env, sessionId, phase, startedAt, details)))("workflow.metadata.saved", saveStart, {
    status,
  });
}

async function markPromptError(
  env: Env,
  sessionId: string,
  message: string,
  timing?: WorkflowTimingLog,
): Promise<void> {
  const runtime = new SessionRuntimeRepository(env.DB);
  const events = new SessionEventRepository(env.DB);
  const sessions = new SessionRepository(env.DB);
  const stored = await loadAgentSession(env, sessionId, undefined, timing);
  const erroredSession: AgentSessionState = {
    ...stored.session,
    updatedAt: Date.now(),
    status: "error",
    errorMessage: message,
  };

  await runtime.saveWorkflowSession(sessionId, erroredSession);
  await appendErrorEvent(events, sessionId, message);
  await saveSessionMetadata(env, sessions, runtime, events, sessionId, "error", message, timing);
}

async function markPromptCancelled(
  env: Env,
  sessionId: string,
  timing?: WorkflowTimingLog,
): Promise<void> {
  const runtime = new SessionRuntimeRepository(env.DB);
  const events = new SessionEventRepository(env.DB);
  const sessions = new SessionRepository(env.DB);
  await appendSessionStatusEvent(events, sessionId, {
    type: "session.status_changed",
    status: "idle",
  });
  await saveSessionMetadata(env, sessions, runtime, events, sessionId, "idle", undefined, timing);
}

export interface RunSessionRunOptions {
  budgetMs?: number;
  leaseMs?: number;
  workerId?: string;
  ctx?: ExecutionContext;
}

const DEFAULT_RUN_BUDGET_MS = 20_000;
const DEFAULT_RUN_LEASE_MS = 30_000;
const RUN_BUDGET_BUFFER_MS = 1_500;

class TimeBudgetExceeded extends Error {
  constructor() {
    super("Session run yielded before the Worker time budget expired");
  }
}

class SessionRunCancelled extends Error {
  constructor() {
    super("Session run was cancelled");
  }
}

class SessionRunCheckpointContext {
  constructor(
    private readonly repo: SessionRunRepository,
    private readonly run: SessionRun,
    private readonly deadline: number,
    private readonly timing: WorkflowTimingLog,
  ) {}

  assertBudget(): void {
    if (Date.now() + RUN_BUDGET_BUFFER_MS >= this.deadline) {
      throw new TimeBudgetExceeded();
    }
  }

  async assertCanContinue(): Promise<void> {
    this.assertBudget();
    const latest = await this.repo.find(this.run.id);
    if (latest?.status === "cancel_requested" || latest?.status === "cancelled") {
      throw new SessionRunCancelled();
    }
  }

  async step<T>(name: string, callback: () => Promise<T>): Promise<T> {
    await this.assertCanContinue();
    const cached = await this.repo.getCompletedStep(this.run.id, name);
    if (cached !== undefined) {
      this.timing("workflow.step.replayed", undefined, { stepName: name });
      return cached as T;
    }

    const stepStart = timingStart();
    const result = await callback();
    await this.assertCanContinue();
    await this.repo.completeStep(this.run.id, name, this.run.attempt, serializeForWorkflow(result));
    this.timing("workflow.step.completed", stepStart, { stepName: name });
    return result;
  }
}

export async function runSessionRun(
  env: Env,
  runId: string,
  options: RunSessionRunOptions = {},
): Promise<void> {
  const repo = new SessionRunRepository(env.DB);
  const workerId = options.workerId ?? crypto.randomUUID();
  const leaseMs = options.leaseMs ?? DEFAULT_RUN_LEASE_MS;
  const budgetMs = options.budgetMs ?? DEFAULT_RUN_BUDGET_MS;
  const deadline = Date.now() + budgetMs;
  const claimStart = timingStart();
  const claimed = await repo.claim({ runId, workerId, leaseMs });
  if (!claimed) return;

  const sessionId = claimed.sessionId;
  const collector = new TimingCollector();
  const timing = createWorkflowTiming(env, sessionId, collector);
  timing("workflow.run.claimed", claimStart, {
    runId,
    workerId,
    attempt: claimed.attempt,
    leaseMs,
    budgetMs,
  });

  const checkpoints = new SessionRunCheckpointContext(repo, claimed, deadline, timing);

  try {
    const runtime = new SessionRuntimeRepository(env.DB);
    await runtime.setActive(sessionId, true);

    if (claimed.input.type !== "prompt") {
      await repo.cancel(runId);
      await runtime.setActive(sessionId, false);
      return;
    }

    const promptStart = timingStart();
    timing("workflow.prompt.start", undefined, {
      runId,
      promptLength: claimed.input.content.length,
      maxTurns: claimed.input.maxTurns,
      ...promptApiTimingDetails(claimed.input),
    });
    await processPrompt(env, options.ctx, claimed, checkpoints, claimed.input, 0, timing);
    timing("workflow.prompt.done", promptStart);
    await repo.complete(runId, workerId);
    await runtime.setActive(sessionId, false);
  } catch (error) {
    if (error instanceof SessionRunCancelled) {
      await repo.cancel(runId);
      const runtime = new SessionRuntimeRepository(env.DB);
      await runtime.setActive(sessionId, false);
      await markPromptCancelled(env, sessionId, timing);
      timing("workflow.run.cancelled", undefined, { runId });
      return;
    }

    if (error instanceof TimeBudgetExceeded) {
      await repo.releaseRunnable(runId, workerId);
      const continuationScheduled = Boolean(options.ctx);
      timing("workflow.run.yielded", undefined, {
        runId,
        reason: "time_budget",
        continuationScheduled,
      });
      options.ctx?.waitUntil(runSessionRun(env, runId, {
        budgetMs,
        leaseMs,
        ctx: options.ctx,
      }));
      return;
    }

    const message = errorMessage(error);
    logger.error("Session run failed", error, {
      runId,
      sessionId,
    });
    await repo.fail(runId, workerId, message);
    await markPromptError(env, sessionId, message, timing);
  } finally {
    await flushTimingCollector(env, collector, {
      sessionId,
      reason: "session_run_finally",
      runId,
    });
  }
}

export async function recoverSessionRuns(
  env: Env,
  options: { limit?: number; budgetMs?: number; ctx?: ExecutionContext } = {},
): Promise<void> {
  const repo = new SessionRunRepository(env.DB);
  const due = await repo.listDue(options.limit ?? 5);
  await Promise.all(due.map((run) => runSessionRun(env, run.id, {
    budgetMs: options.budgetMs,
    ctx: options.ctx,
  })));
}

async function processPrompt(
  env: Env,
  ctx: ExecutionContext | undefined,
  run: SessionRun,
  checkpoints: SessionRunCheckpointContext,
  input: Extract<SessionInputEvent, { type: "prompt" }>,
  inputIndex: number,
  timing: WorkflowTimingLog,
): Promise<void> {
  const sessionId = run.sessionId;
  let agentSession: AgentSessionState;
  let nextStep: NextStepInfo | undefined;
  let completedTurns = 0;
  let agentStep = 0;
  const maxTurns = input.maxTurns ?? 20;

  try {
    const enqueued = await checkpoints.step(`enqueue-prompt-${inputIndex}`, async () => {
      const stepCollector = new TimingCollector();
      const stepTiming = createWorkflowTiming(env, sessionId, stepCollector);
      const runtime = new SessionRuntimeRepository(env.DB);
      const events = new SessionEventRepository(env.DB);
      const messages = new SessionMessageRepository(env.DB);

      const loaded = await loadAgentSession(env, sessionId, undefined, stepTiming);
      const loadedSession = loaded.session;
      const enqueueStart = timingStart();
      const enqueueResult = Agent.enqueuePrompt(loadedSession, input.content);
      let nextStep = Agent.determineNextStep(enqueueResult.session) ?? null;
      stepTiming("workflow.prompt.enqueued", enqueueStart, {
        eventCount: enqueueResult.events.length,
        nextStepType: nextStep?.type,
        nextStepId: nextStep?.stepId,
        ...promptApiTimingDetails(input),
      });

      const saveStart = timingStart();
      const appendStart = timingStart();
      const savedSessionPromise = runtime.saveWorkflowSession(sessionId, enqueueResult.session).then((savedSession) => {
        stepTiming("workflow.session.saved", saveStart, {
          status: enqueueResult.session.status,
          messageCount: enqueueResult.session.messages.length,
          turnCount: enqueueResult.session.turns.length,
          serializedBytes: savedSession.serializedBytes,
          written: savedSession.written,
          skippedUnchanged: savedSession.skippedUnchanged,
        });
        return savedSession;
      });
      const appendEventsPromise = appendAgentEvents(env, events, messages, sessionId, enqueueResult.events, run.workspaceId, stepTiming).then(() => {
        stepTiming("workflow.prompt.events_appended", appendStart, {
          eventCount: enqueueResult.events.length,
          eventTypes: enqueueResult.events.map((event) => event.type),
        });
      });
      let [savedSession] = await Promise.all([savedSessionPromise, appendEventsPromise]);

      if (nextStep?.type === "assistant") {
        const currentStep = nextStep;
        const stepStart = timingStart();
        stepTiming("workflow.agent_step.start", undefined, {
          stepType: currentStep.type,
          stepId: currentStep.stepId,
          displayName: currentStep.displayName,
          ...promptApiTimingDetails(input),
        });
        const liveEvents = new LiveAgentEventPersister((agentEvents) =>
          appendAgentEvents(env, events, messages, sessionId, agentEvents, run.workspaceId, stepTiming)
        );
        const agentContext = loaded.agentContext ?? await createWorkflowAgentContext(env, sessionId, stepTiming);
        const agent = await createWorkflowAgent(
          env,
          ctx,
          sessionId,
          (event) => liveEvents.onEvent(event),
          agentContext,
          stepTiming,
          () => promptApiTimingDetails(input),
        );
        const assistantResult = await agent.runSingleStep(enqueueResult.session, currentStep);
        stepTiming("workflow.agent_step.ran", stepStart, {
          stepType: currentStep.type,
          stepId: currentStep.stepId,
          eventCount: assistantResult.events.length,
          nextStepType: assistantResult.nextStep?.type,
          nextStepId: assistantResult.nextStep?.stepId,
          sessionStatus: assistantResult.session.status,
          combinedWithPromptEnqueue: true,
        });

        const assistantSaveStart = timingStart();
        savedSession = await runtime.saveWorkflowSession(sessionId, assistantResult.session);
        stepTiming("workflow.session.saved", assistantSaveStart, {
          status: assistantResult.session.status,
          messageCount: assistantResult.session.messages.length,
          turnCount: assistantResult.session.turns.length,
          serializedBytes: savedSession.serializedBytes,
          written: savedSession.written,
          skippedUnchanged: savedSession.skippedUnchanged,
          combinedWithPromptEnqueue: true,
        });
        await liveEvents.flushUpdates();
        const unpersistedEvents = assistantResult.events.filter((event) => !liveEvents.hasHandled(event));
        await appendAgentEvents(env, events, messages, sessionId, unpersistedEvents, run.workspaceId, stepTiming);
        nextStep = assistantResult.nextStep ?? null;
      }

      await flushTimingCollector(env, stepCollector, {
        sessionId,
        reason: "enqueue_prompt",
      });

      return {
        session: deserializeForWorkflow(savedSession.serializedJson),
        nextStep: serializeForWorkflow(nextStep),
      };
    });

    agentSession = requireAgentSessionState(enqueued.session);
    nextStep = optionalNextStepInfo(enqueued.nextStep);

    while (nextStep) {
      await checkpoints.assertCanContinue();
      const currentStep = nextStep;
      const stepResult = await checkpoints.step(
        `agent-${inputIndex}-${agentStep++}-${currentStep.stepId}`,
        async () => {
          const stepCollector = new TimingCollector();
          const stepTiming = createWorkflowTiming(env, sessionId, stepCollector);
          const stepStart = timingStart();
          stepTiming("workflow.agent_step.start", undefined, {
            stepType: currentStep.type,
            stepId: currentStep.stepId,
            displayName: currentStep.displayName,
            toolCallId: currentStep.toolCallId,
            toolCallIds: currentStep.toolCallIds,
            ...promptApiTimingDetails(input),
          });
          const runtime = new SessionRuntimeRepository(env.DB);
          const events = new SessionEventRepository(env.DB);
          const messages = new SessionMessageRepository(env.DB);
          const liveEvents = new LiveAgentEventPersister((agentEvents) =>
            appendAgentEvents(env, events, messages, sessionId, agentEvents, run.workspaceId, stepTiming)
          );
          const result = currentStep.type === "complete"
            ? (() => {
                const completeResult = Agent.completeTurn(agentSession);
                const nextStep = Agent.determineNextStep(completeResult.session);
                return {
                  session: completeResult.session,
                  events: completeResult.events,
                  nextStep,
                  shouldContinue: Boolean(nextStep) && completeResult.session.status !== "error",
                  shouldStop: !nextStep || completeResult.session.status === "error",
                };
              })()
            : await (async () => {
                const agentContext = await createWorkflowAgentContext(env, sessionId, stepTiming);
                const agent = await createWorkflowAgent(
                  env,
                  ctx,
                  sessionId,
                  (event) => liveEvents.onEvent(event),
                  agentContext,
                  stepTiming,
                  () => promptApiTimingDetails(input),
                );
                return agent.runSingleStep(agentSession, currentStep);
              })();
          stepTiming("workflow.agent_step.ran", stepStart, {
            stepType: currentStep.type,
            stepId: currentStep.stepId,
            eventCount: result.events.length,
            nextStepType: result.nextStep?.type,
            nextStepId: result.nextStep?.stepId,
            sessionStatus: result.session.status,
          });
          await checkpoints.assertCanContinue();

          const saveStart = timingStart();
          const savedSession = await runtime.saveWorkflowSession(sessionId, result.session);
          stepTiming("workflow.session.saved", saveStart, {
            status: result.session.status,
            messageCount: result.session.messages.length,
            turnCount: result.session.turns.length,
            serializedBytes: savedSession.serializedBytes,
            written: savedSession.written,
            skippedUnchanged: savedSession.skippedUnchanged,
          });
          await liveEvents.flushUpdates();
          const unpersistedEvents = result.events.filter((event) => !liveEvents.hasHandled(event));
          await appendAgentEvents(env, events, messages, sessionId, unpersistedEvents, run.workspaceId, stepTiming);

          await flushTimingCollector(env, stepCollector, {
            sessionId,
            reason: "agent_step",
            stepType: currentStep.type,
            stepId: currentStep.stepId,
          });

          return {
            session: deserializeForWorkflow(savedSession.serializedJson),
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
        const limited = await checkpoints.step(`agent-${inputIndex}-max-turns`, async () => {
          const stepCollector = new TimingCollector();
          const stepTiming = createWorkflowTiming(env, sessionId, stepCollector);
          const limitStart = timingStart();
          const runtime = new SessionRuntimeRepository(env.DB);
          const events = new SessionEventRepository(env.DB);
          const erroredSession: AgentSessionState = {
            ...agentSession,
            updatedAt: Date.now(),
            status: "error",
            errorMessage: message,
          };

          const savedSession = await runtime.saveWorkflowSession(sessionId, erroredSession);
          await appendErrorEvent(events, sessionId, message);
          stepTiming("workflow.max_turns_saved", limitStart, {
            maxTurns,
            serializedBytes: savedSession.serializedBytes,
            written: savedSession.written,
            skippedUnchanged: savedSession.skippedUnchanged,
          });
          await flushTimingCollector(env, stepCollector, {
            sessionId,
            reason: "max_turns",
          });
          return deserializeForWorkflow(savedSession.serializedJson);
        });

        agentSession = requireAgentSessionState(limited);
        nextStep = undefined;
      }
    }

    await checkpoints.step(`finalize-prompt-${inputIndex}`, async () => {
      const stepCollector = new TimingCollector();
      const stepTiming = createWorkflowTiming(env, sessionId, stepCollector);
      const finalizeStart = timingStart();
      const sessions = new SessionRepository(env.DB);
      const runtime = new SessionRuntimeRepository(env.DB);
      const events = new SessionEventRepository(env.DB);
      const status = agentSession.status === "error" ? "error" : "idle";
      stepTiming("workflow.prompt.finalizing", finalizeStart, {
        currentSessionStatus: agentSession.status,
        willSetStatusTo: status,
      });
      await saveSessionMetadata(env, sessions, runtime, events, sessionId, status, agentSession.errorMessage, stepTiming);
      stepTiming("workflow.prompt.finalized", finalizeStart, { status });
      await flushTimingCollector(env, stepCollector, {
        sessionId,
        reason: "finalize_prompt",
        status,
      });
    });
  } catch (error) {
    if (error instanceof TimeBudgetExceeded) {
      throw error;
    }

    const message = errorMessage(error);
    logger.error("Workflow prompt failed", error, {
      sessionId,
      inputIndex,
      maxTurns,
    });

    timing("workflow.prompt.error", undefined, {
      error: message,
    });

    await checkpoints.step(`prompt-error-${inputIndex}`, async () => {
      const stepCollector = new TimingCollector();
      const stepTiming = createWorkflowTiming(env, sessionId, stepCollector);
      const errorStart = timingStart();
      await markPromptError(env, sessionId, message, stepTiming);
      stepTiming("workflow.prompt.error_saved", errorStart);
      await flushTimingCollector(env, stepCollector, {
        sessionId,
        reason: "prompt_error",
      });
    });
  }
}
