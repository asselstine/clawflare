// Clawflare Workflow Agent - Durable, multi-step agent execution
// Uses Cloudflare Workflows for automatic retry, persistence, and long-running tasks

import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from "cloudflare:workers";
import type { Env } from "./types";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { getModel, getProviders, streamSimple, type Api, type Model, type BedrockOptions } from "@earendil-works/pi-ai";
import { createTools } from "./tools";
import { createMockStream, shouldUseMockAI } from "./mock-ai";

// Default provider and model configuration
const DEFAULT_PROVIDER: "amazon-bedrock" = "amazon-bedrock";
const DEFAULT_MODEL_ID: "minimax.minimax-m2.5" = "minimax.minimax-m2.5";

// Serializable workflow state (AgentMessage must be stringified)
interface WorkflowState {
  instanceId: string;
  contextId: string;
  messagesJson: string; // JSON-serialized AgentMessage[]
  turnCount: number;
  maxTurns: number;
  status: "running" | "idle" | "error" | "awaiting_input";
  errorMessage?: string;
}

// Input to start a workflow instance
interface WorkflowInput {
  contextId: string;
  prompt: string;
  maxTurns?: number;
}

// Result from a turn execution
interface TurnResult {
  messagesJson: string;
  turnCount: number;
  shouldStop: boolean;
  hasError: boolean;
  errorMessage?: string;
}

export class ClawflareAgentWorkflow extends WorkflowEntrypoint<Env, WorkflowInput> {
  async run(event: WorkflowEvent<WorkflowInput>, step: WorkflowStep) {
    const { contextId, prompt, maxTurns = 10 } = event.payload;
    const instanceId = event.instanceId;
    
    // Step 1: Initialize state from KV or create new
    const initialState = await step.do("initialize", async () => {
      return initializeState(this.env, instanceId, contextId, prompt, maxTurns);
    });

    // Run agent loop with durable persistence per turn
    let currentState = initialState;
    
    while (true) {
      const state = currentState; // Capture for closure
      
      // Check loop conditions
      if (state.status !== "running" || state.turnCount >= state.maxTurns) {
        break;
      }

      // Each turn is a durable step with retry logic
      const turnResult = await step.do(
        `turn-${state.turnCount}`,
        {
          retries: {
            limit: 3,
            delay: "5 seconds",
            backoff: "exponential",
          },
          timeout: "2 minutes",
        },
        async () => {
          return runAgentTurnWithRetry(
            this.env,
            state,
            this.ctx
          );
        }
      );

      // Persist state after each turn
      currentState = await step.do(
        `persist-turn-${state.turnCount}`,
        async () => {
          return persistState(this.env, contextId, state, turnResult);
        }
      );

      // Check if we should continue
      if (turnResult.shouldStop) {
        currentState.status = turnResult.hasError ? "error" : "idle";
        if (turnResult.errorMessage) {
          currentState.errorMessage = turnResult.errorMessage;
        }
        break;
      }
    }

    // Finalize
    const finalState = await step.do("finalize", async () => {
      if (currentState.turnCount >= currentState.maxTurns) {
        currentState.status = "error";
        currentState.errorMessage = `Exceeded maximum turns (${maxTurns})`;
      }
      
      // Save final state
      await this.env.AGENT_STATE.put(
        `workflow:${instanceId}`,
        JSON.stringify(currentState)
      );
      
      return currentState;
    });

    return finalState;
  }
}

async function initializeState(
  env: Env,
  instanceId: string,
  contextId: string,
  prompt: string,
  maxTurns: number
): Promise<WorkflowState> {
  // Load existing context from KV
  const stateJson = await env.AGENT_STATE.get(contextId);
  const existing = stateJson ? JSON.parse(stateJson) : null;
  
  const messages: AgentMessage[] = existing?.messages || [];
  
  // Add the new prompt
  messages.push({
    role: "user",
    content: [{ type: "text", text: prompt }],
    timestamp: Date.now(),
  } as AgentMessage);

  const state: WorkflowState = {
    instanceId,
    contextId,
    messagesJson: JSON.stringify(messages),
    turnCount: 0,
    maxTurns,
    status: "running",
  };

  await env.AGENT_STATE.put(`workflow:${instanceId}`, JSON.stringify(state));
  return state;
}

// Run one agent turn with the existing agent pattern
async function runAgentTurnWithRetry(
  env: Env,
  state: WorkflowState,
  ctx: ExecutionContext
): Promise<TurnResult> {
  const messages: AgentMessage[] = JSON.parse(state.messagesJson);
  
  // Load agent library dynamically
  const { Agent } = await import("@earendil-works/pi-agent-core");
  
  // Build components
  const { model, streamFn, tools, getApiKey } = await buildAgentComponents(env, ctx);
  
  // Create agent
  const agent = new Agent({
    getApiKey,
    streamFn,
    initialState: {
      systemPrompt: getSystemPrompt(),
      model,
      tools,
      messages: [...messages], // Copy to avoid mutation
    },
  });

  // Track execution
  let turnMessages: AgentMessage[] = messages;
  let turnCount = state.turnCount;
  let hasError = false;
  let errorMessage: string | undefined;
  let shouldStop = false;

  // Get the last user message to prompt with
  const userMessages = turnMessages.filter(m => m.role === "user");
  const lastUserMessage = userMessages[userMessages.length - 1];
  const messageContent = Array.isArray(lastUserMessage?.content) 
    ? lastUserMessage.content.map(c => c.type === "text" ? c.text : "").join("")
    : String(lastUserMessage?.content || "");

  return new Promise((resolve) => {
    // Set timeout
    const timeoutId = setTimeout(() => {
      hasError = true;
      errorMessage = "Agent turn timed out after 2 minutes";
      shouldStop = true;
      resolve({
        messagesJson: JSON.stringify(turnMessages),
        turnCount: turnCount + 1,
        shouldStop: true,
        hasError: true,
        errorMessage,
      });
    }, 120000);

    const unsubscribe = agent.subscribe(async (event) => {
      try {
        // Track turn progression
        if (event.type === "turn_start") {
          turnCount = state.turnCount + 1;
        }

        // Update messages on end
        if (event.type === "message_end") {
          if (event.message) {
            turnMessages = [...turnMessages, event.message];
          }
        }

        // Agent finished
        if (event.type === "agent_end") {
          clearTimeout(timeoutId);
          unsubscribe();
          
          turnMessages = event.messages;
          
          // Determine if agent is idle or needs more turns
          const lastMessage = event.messages[event.messages.length - 1];
          const lastAssistant = lastMessage?.role === "assistant" ? lastMessage : undefined;
          // Check content for tool calls - agent messages can have toolCall content
          const content = lastAssistant && Array.isArray(lastAssistant.content)
            ? lastAssistant.content
            : [];
          const hasToolCallBlock = content.some(c => c.type === "toolCall");
          
          // Stop if no tool calls (agent is idle) or we've hit max
          shouldStop = !hasToolCallBlock;
          
          resolve({
            messagesJson: JSON.stringify(turnMessages),
            turnCount,
            shouldStop,
            hasError,
            errorMessage,
          });
        }
      } catch (error) {
        clearTimeout(timeoutId);
        unsubscribe();
        hasError = true;
        errorMessage = error instanceof Error ? error.message : String(error);
        shouldStop = true;
        resolve({
          messagesJson: JSON.stringify(turnMessages),
          turnCount: turnCount + 1,
          shouldStop: true,
          hasError: true,
          errorMessage,
        });
      }
    });

    // Start agent with the last user message
    agent.prompt(messageContent).catch((err) => {
      clearTimeout(timeoutId);
      unsubscribe();
      hasError = true;
      errorMessage = err instanceof Error ? err.message : String(err);
      shouldStop = true;
      resolve({
        messagesJson: JSON.stringify(turnMessages),
        turnCount: turnCount + 1,
        shouldStop: true,
        hasError: true,
        errorMessage,
      });
    });
  });
}

async function persistState(
  env: Env,
  contextId: string,
  state: WorkflowState,
  turnResult: TurnResult
): Promise<WorkflowState> {
  const newState: WorkflowState = {
    ...state,
    messagesJson: turnResult.messagesJson,
    turnCount: turnResult.turnCount,
  };

  // Save to KV for external access
  const messages: AgentMessage[] = JSON.parse(turnResult.messagesJson);
  await env.AGENT_STATE.put(
    contextId,
    JSON.stringify({
      id: contextId,
      messages,
      createdAt: Date.now(),
    })
  );
  await env.AGENT_STATE.put(`workflow:${state.instanceId}`, JSON.stringify(newState));

  return newState;
}

async function buildAgentComponents(
  env: Env,
  execCtx?: ExecutionContext
): Promise<{
  model: Model<Api>;
  streamFn: typeof streamSimple;
  tools: AgentTool[];
  getApiKey: (provider?: string) => Promise<string | undefined>;
}> {
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

  return { model, streamFn: streamFn as typeof streamSimple, tools, getApiKey };
}

function resolveConfiguredModel(env: Env): { provider: string; modelId: string; model: Model<Api> } {
  const provider = env.AI_PROVIDER || DEFAULT_PROVIDER;
  const modelId = env.AI_MODEL || DEFAULT_MODEL_ID;

  if (!getProviders().includes(provider as never)) {
    throw new Error(`Unknown AI_PROVIDER: ${provider}`);
  }

  const model = getModel(provider as never, modelId as never) as Model<Api> | undefined;
  if (!model) {
    throw new Error(`Model not found: ${provider}/${modelId}`);
  }

  return { provider, modelId, model };
}

function normalizeBedrockBearerToken(token: string | undefined): string | undefined {
  const trimmed = token?.trim();
  if (!trimmed) return undefined;
  const unquoted = trimmed.replace(/^(?:["'])(.*)(?:["'])$/, "$1").trim();
  return unquoted.replace(/^Bearer\s+/i, "").trim() || undefined;
}

function getApiKeyForProvider(env: Env, provider: string): string | undefined {
  switch (provider) {
    case "amazon-bedrock":
      return normalizeBedrockBearerToken(env.AWS_BEARER_TOKEN_BEDROCK);
    case "anthropic":
      return env.ANTHROPIC_OAUTH_TOKEN || env.ANTHROPIC_API_KEY;
    case "openai":
      return env.OPENAI_API_KEY;
    case "azure-openai-responses":
      return env.AZURE_OPENAI_API_KEY;
    case "deepseek":
      return env.DEEPSEEK_API_KEY;
    case "google":
      return env.GEMINI_API_KEY;
    case "google-vertex":
      return env.GOOGLE_CLOUD_API_KEY;
    case "groq":
      return env.GROQ_API_KEY;
    case "cerebras":
      return env.CEREBRAS_API_KEY;
    case "xai":
      return env.XAI_API_KEY;
    case "openrouter":
      return env.OPENROUTER_API_KEY;
    case "vercel-ai-gateway":
      return env.AI_GATEWAY_API_KEY;
    case "zai":
      return env.ZAI_API_KEY;
    case "mistral":
      return env.MISTRAL_API_KEY;
    case "minimax":
      return env.MINIMAX_API_KEY;
    case "minimax-cn":
      return env.MINIMAX_CN_API_KEY;
    case "moonshotai":
    case "moonshotai-cn":
      return env.MOONSHOT_API_KEY;
    case "huggingface":
      return env.HF_TOKEN;
    case "fireworks":
      return env.FIREWORKS_API_KEY;
    case "opencode":
    case "opencode-go":
      return env.OPENCODE_API_KEY;
    case "kimi-coding":
      return env.KIMI_API_KEY;
    case "cloudflare-workers-ai":
    case "cloudflare-ai-gateway":
      return env.CLOUDFLARE_API_KEY || env.CLOUDFLARE_API_TOKEN;
    case "xiaomi":
      return env.XIAOMI_API_KEY;
    case "xiaomi-token-plan-cn":
      return env.XIAOMI_TOKEN_PLAN_CN_API_KEY;
    case "xiaomi-token-plan-ams":
      return env.XIAOMI_TOKEN_PLAN_AMS_API_KEY;
    case "xiaomi-token-plan-sgp":
      return env.XIAOMI_TOKEN_PLAN_SGP_API_KEY;
    default:
      return undefined;
  }
}

async function createBedrockStreaming(env: Env): Promise<typeof streamSimple> {
  const { bedrockProviderModule } = await import("@earendil-works/pi-ai/bedrock-provider");
  const { streamBedrock } = bedrockProviderModule;

  const bearerToken = normalizeBedrockBearerToken(env.AWS_BEARER_TOKEN_BEDROCK);
  
  return ((m: Model<"bedrock-converse-stream">, ctx: Parameters<typeof streamSimple>[1], opts?: BedrockOptions) => {
    const bedrockOptions: BedrockOptions = {
      ...opts,
      bearerToken,
      apiKey: bearerToken,
      region: env.AWS_REGION || "us-east-1",
      profile: env.AWS_PROFILE,
    };
    return streamBedrock(m, ctx, bedrockOptions);
  }) as typeof streamSimple;
}

function getSystemPrompt(): string {
  return `You are Clawflare, an AI agent that runs on Cloudflare's platform.

You have exactly four tools:
- execute_code: Run JavaScript in an isolated Dynamic Worker.
- store_code: Save reusable JavaScript by name.
- execute_stored_code: Run previously stored JavaScript by name.
- search: Query available stored code, egress handlers, and other indexed records.

Network egress from executed code is controlled by a gateway. Before relying on outbound HTTP, use search to inspect supported egress handlers/domains. Unsupported outbound requests are blocked.

Prefer storing reusable code when it will save tokens in future turns.
Be helpful, concise, and focus on getting tasks done efficiently.`;
}

// Query workflow status
export async function getWorkflowStatus(
  env: Env,
  instanceId: string
): Promise<{
  status: "running" | "success" | "errored" | "paused";
  state?: WorkflowState;
  currentStep?: string;
}> {
  const stateJson = await env.AGENT_STATE.get(`workflow:${instanceId}`);
  if (!stateJson) {
    return { status: "errored", currentStep: "instance_not_found" };
  }
  
  const state = JSON.parse(stateJson) as WorkflowState;
  
  return {
    status: state.status === "running" ? "running" : 
            state.status === "error" ? "errored" : "success",
    state,
    currentStep: `turn-${state.turnCount}`,
  };
}
