// Persistent Session Workflow - One workflow per session, stays alive until closed
// Uses step.waitForEvent() to pause between user prompts

import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from "cloudflare:workers";
import type { Env, SessionInputEvent, SessionState } from "./types";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { Agent } from "./agent";
import { createTools } from "./tools";
import { streamSimple } from "@earendil-works/pi-ai";
import {
  resolveConfiguredModel,
  getApiKeyForProvider,
  createBedrockStreaming,
  getSystemPrompt,
  type BuildAgentComponentsResult,
} from "./agent-config";
import { createMockStream, shouldUseMockAI } from "./mock-ai";
import {
  loadSessionState,
  saveSessionState,
  appendSessionEvents,
  markSessionClosed,
  setSessionActive,
  saveSessionWorkflowId,
  dequeueSessionInput,
} from "./session-store";
import { loadSession, saveSession } from "./workflow-state";
import { createEmptyAgentSession } from "./agent";
import { logTiming, timingStart } from "./diagnostics";

interface PersistentWorkflowInput {
  sessionId: string;
}

const DEFAULT_IDLE_TIMEOUT = "7 days";
const DEFAULT_MAX_TURNS = 20;

export class PersistentSessionWorkflow extends WorkflowEntrypoint<Env, PersistentWorkflowInput> {
  async run(event: WorkflowEvent<PersistentWorkflowInput>, step: WorkflowStep) {
    const { sessionId } = event.payload;
    const workflowId = event.instanceId;
    
    try {
      return await this.runSessionLoop(event, step);
    } catch (error) {
      await this.handleFatalError(sessionId, workflowId, error);
      throw error; // Re-throw so it's visible in logs
    }
  }

  private async runSessionLoop(event: WorkflowEvent<PersistentWorkflowInput>, step: WorkflowStep) {
    const { sessionId } = event.payload;
    const workflowId = event.instanceId;
    const runStart = timingStart();

    // Step 1: Initialize session
    await step.do("init", async () => {
      await this.initializeSession(sessionId, workflowId);
    });

    logTiming(this.env, sessionId, "workflow.session.initialized", runStart);

    // Main session loop - runs until closed, expired, or error
    let turnIndex = 0;
    while (true) {
      turnIndex++;
      const turnStart = timingStart();

      // Step 2: Wait for input (or timeout)
      // This is the key: workflow pauses here, consuming minimal resources
      const inputEvent = await this.waitForInput(step, sessionId, turnIndex);
      
      if (!inputEvent) {
        // Timeout - session expired
        await step.do("timeout", async () => {
          await markSessionClosed(this.env, sessionId, "timeout");
        });
        return { sessionId, status: "expired", reason: "idle_timeout" };
      }

      if (inputEvent.type === "close") {
        // User requested close
        await step.do("close", async () => {
          await markSessionClosed(this.env, sessionId, "user");
        });
        return { sessionId, status: "closed", reason: "user_request" };
      }

      // Step 3: Process this turn
      logTiming(this.env, sessionId, "workflow.input.received", turnStart, {
        inputType: inputEvent.type,
      });

      const turnResult = await this.processTurn(step, sessionId, inputEvent, turnIndex);

      if (!turnResult.success) {
        // Step failed but workflow continues
        // Error is stored in events for user visibility
        logTiming(this.env, sessionId, "workflow.turn.failed", turnStart, {
          error: turnResult.error,
        });
        // Continue to next input - user can decide what to do
      } else {
        logTiming(this.env, sessionId, "workflow.turn.complete", turnStart, {
          turnResult: turnResult.stopReason,
        });
      }
    }
  }

  private async initializeSession(sessionId: string, workflowId: string): Promise<void> {
    // Store workflow ID in session
    await saveSessionWorkflowId(this.env, sessionId, workflowId);
    await setSessionActive(this.env, sessionId, true);

    // Ensure polling session state exists
    let state = await loadSessionState(this.env, sessionId);
    if (!state) {
      // Create new state for HTTP handler created sessions
      state = {
        id: sessionId,
        workflowId,
        status: "idle",  // Only set idle for newly created state (older sessions)
        messages: [],
        nextEventCursor: "0",
        updatedAt: Date.now(),
      };
      await saveSessionState(this.env, state);
    } else {
      // Update workflow ID but preserve status (HTTP handler sets it to "processing")
      state.workflowId = workflowId;
      state.updatedAt = Date.now();
      // Don't overwrite status - HTTP handler or previous workflow run sets it
      await saveSessionState(this.env, state);
    }

    // Create workflow session for agent to use during turn processing
    const { model } = resolveConfiguredModel(this.env);
    const workflowSession = createEmptyAgentSession({
      sessionId,
      systemPrompt: getSystemPrompt(),
      model,
    });
    await saveSession(this.env, workflowSession);
  }

  private async waitForInput(
    step: WorkflowStep,
    sessionId: string,
    turnIndex: number,
  ): Promise<SessionInputEvent | null> {
    let waitAttempt = 0;

    while (true) {
      // First check if there's already a queued input
      // (in case event arrived while previous turn was running)
      const queued = await dequeueSessionInput(this.env, sessionId);
      if (queued.event) {
        return queued.event;
      }

      // No queued input - use waitForEvent as a wake-up signal only.
      // The durable input queue remains the source of truth; this avoids
      // dropping events sent while the workflow was busy and avoids processing
      // stale wake events as duplicate prompts.
      const waitResult = await step.waitForEvent(`await-input-${turnIndex}-${waitAttempt++}`, {
        type: "session-input",
        timeout: DEFAULT_IDLE_TIMEOUT,
      });

      if (!waitResult) {
        // Timeout
        return null;
      }
    }
  }

  private async processTurn(
    step: WorkflowStep,
    sessionId: string,
    inputEvent: SessionInputEvent,
    turnIndex: number,
  ): Promise<{ success: boolean; error?: string; stopReason?: string }> {
    return step.do(
      `turn-${turnIndex}-${inputEvent.type}`,
      {
        retries: {
          limit: 3,
          delay: "5 seconds",
          backoff: "exponential",
        },
        timeout: "2 minutes",
      },
      async () => {
        const turnStart = timingStart();

        try {
          // Load components (model, tools, etc.)
          const components = await buildAgentComponents(this.env, this.ctx);
          const agent = this.createAgent(components, sessionId);

          // Load agent session state
          const loadedSession = await loadSession(this.env, sessionId);

          // Update status to processing
          await this.updateSessionStatus(sessionId, "processing");

          let currentSession = loadedSession;
          let events: AgentEvent[] = [];

          // Handle different input types
          if (inputEvent.type === "prompt" && inputEvent.content) {
            // Enqueue prompt
            const result = agent.enqueuePrompt(currentSession, inputEvent.content);
            currentSession = result.session;
            events = result.events;
          } else if (inputEvent.type === "steer" && inputEvent.content) {
            // Steering message
            currentSession = agent.enqueueSteering(currentSession, inputEvent.content);
          } else if (inputEvent.type === "fork") {
            // Fork handled by creating new session - this shouldn't reach here
            return { success: true, stopReason: "fork_not_supported_in_turn" };
          }

          // Append enqueue events
          if (events.length > 0) {
            await appendSessionEvents(
              this.env,
              sessionId,
              events.map((e) => ({ ...e, timestamp: Date.now() })),
            );
          }

          // Save initial state
          await saveSession(this.env, currentSession);

          // Run steps until turn complete or error
          let turnCount = 0;
          const maxTurns = (inputEvent as { maxTurns?: number }).maxTurns ?? DEFAULT_MAX_TURNS;

          while (turnCount < maxTurns) {
            const stepInfo = agent.determineNextStep(currentSession);
            if (!stepInfo) break; // Turn complete (idle)

            // Execute step
            const stepResult = await agent.runSingleStep(currentSession, stepInfo);
            currentSession = stepResult.session;

            // Append events
            if (stepResult.events.length > 0) {
              await appendSessionEvents(
                this.env,
                sessionId,
                stepResult.events.map((e) => ({ ...e, timestamp: Date.now() })),
              );
            }

            // Save session
            await saveSession(this.env, currentSession);

            turnCount++;

            if (stepResult.session.status === "error") {
              throw new Error(stepResult.session.errorMessage || "Agent error");
            }

            if (!stepResult.shouldContinue) break;
          }

          // Turn complete - update to idle
          await this.updateSessionStatus(sessionId, "idle");

          logTiming(this.env, sessionId, "workflow.turn.success", turnStart, {
            turnCount,
            messageCount: currentSession.messages.length,
          });

          return { success: true, stopReason: turnCount >= maxTurns ? "max_turns" : "complete" };
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          
          // Store error in session for visibility
          await this.updateSessionStatus(sessionId, "error", errorMessage);
          
          // Error is already logged via session status update
          // Events array will pick up the error state on next poll

          logTiming(this.env, sessionId, "workflow.turn.error", turnStart, {
            error: errorMessage,
          });

          // Return non-success but don't throw - workflow continues
          return { success: false, error: errorMessage };
        }
      },
    );
  }

  private async updateSessionStatus(
    sessionId: string,
    status: SessionState["status"],
    errorMessage?: string,
  ): Promise<void> {
    const state = await loadSessionState(this.env, sessionId);
    if (state) {
      state.status = status;
      state.updatedAt = Date.now();
      if (errorMessage) state.errorMessage = errorMessage;
      
      // Sync messages from workflow session to polling state
      if (status === "idle" || status === "error") {
        try {
          const workflowSession = await loadSession(this.env, sessionId);
          console.log(`[DEBUG] Workflow session messages count: ${workflowSession?.messages?.length ?? 0}`);
          if (workflowSession?.messages) {
            state.messages = workflowSession.messages;
          }
        } catch (err) {
          // If workflow session not found, keep existing messages
          console.log(`[DEBUG] Failed to load workflow session: ${err}`);
        }
      }
      
      await saveSessionState(this.env, state);
    }
  }

  private async handleFatalError(sessionId: string, workflowId: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[PersistentSessionWorkflow] Fatal error", {
      sessionId,
      workflowId,
      message,
    });

    await markSessionClosed(this.env, sessionId, "error");
    await setSessionActive(this.env, sessionId, false);

    logTiming(this.env, sessionId, "workflow.fatal.error", undefined, {
      error: message,
      workflowId,
    });

    // Note: Cloudflare will restart the workflow on the next sendEvent
    // The new instance will detect the crashed state and can optionally
    // continue or notify the user
  }

  private createAgent(components: BuildAgentComponentsResult, sessionId: string): Agent {
    return new Agent({
      model: components.model,
      tools: components.tools,
      streamFn: components.streamFn,
      getApiKey: components.getApiKey,
      systemPrompt: getSystemPrompt(),
      debugTiming: (phase, startedAt, details) => logTiming(this.env, sessionId, phase, startedAt, details),
      onEvent: async (event: AgentEvent) => {
        // Stream events to session store in real-time
        if (event.type === "message_start" || event.type === "message_update" || event.type === "message_end") {
          try {
            await appendSessionEvents(this.env, sessionId, [{ ...event, timestamp: Date.now() }]);
          } catch (err) {
            // Non-blocking - events will be captured in processTurn anyway
            console.error("Failed to stream event:", err);
          }
        }
      },
    });
  }
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
