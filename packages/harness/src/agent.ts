// Clawflare Agent - Uses pi-agent-core for context management
// This provides the agent logic that handles prompts, tools, and context

import { Agent, type AgentTool, type AgentMessage } from "@earendil-works/pi-agent-core";
import { getModel, getProviders, streamSimple, type Api, type Model, type BedrockOptions, type Usage } from "@earendil-works/pi-ai";
import type { Env, ChatRequest, ChatResponse, AgentContextData } from "./types";
import { createTools } from "./tools";
import { createMockStream, shouldUseMockAI } from "./mock-ai";

// Default provider and model configuration
// Tree-shaking: These are inlined for esbuild define substitution
const DEFAULT_PROVIDER: "amazon-bedrock" = "amazon-bedrock";
const DEFAULT_MODEL_ID: "minimax.minimax-m2.5" = "minimax.minimax-m2.5";

function normalizeBedrockBearerToken(token: string | undefined): string | undefined {
  const trimmed = token?.trim();
  if (!trimmed) return undefined;

  // Accept the common copy/paste forms: raw token, `Bearer <token>`, or a
  // quoted value from a shell/.env snippet. AWS SDK's httpBearerAuth adds the
  // `Bearer` scheme itself, so passing `Bearer ...` as the token produces an
  // invalid `Authorization: Bearer Bearer ...` header.
  const unquoted = trimmed.replace(/^(?:["'])(.*)(?:["'])$/, "$1").trim();
  return unquoted.replace(/^Bearer\s+/i, "").trim() || undefined;
}

// Lazy-load Bedrock-specific imports for bearer token auth
let bedrockModuleImport: typeof import("@earendil-works/pi-ai/bedrock-provider") | undefined;

async function getBedrockModule(): Promise<typeof bedrockModuleImport> {
  if (!bedrockModuleImport) {
    bedrockModuleImport = await import("@earendil-works/pi-ai/bedrock-provider");
  }
  return bedrockModuleImport;
}

export class ClawflareAgentWrapper {
  private agent: Agent;
  private tools: AgentTool[];
  private currentContextId: string = "main";
  private env: Env;

  constructor(agent: Agent, env: Env, tools: AgentTool[]) {
    this.agent = agent;
    this.env = env;
    this.tools = tools;

    // Set tools on the agent
    this.agent.state.tools = tools;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const content = request.content || "";

    // Switch to requested context if provided
    if (request.contextId) {
      this.currentContextId = request.contextId;
    }

    switch (request.type) {
      case "prompt":
        return this.handlePrompt(content);
      case "steer":
        return this.handleSteer(content);
      case "fork":
        return this.handleFork(request.contextId);
      case "new_context":
        return this.handleNewContext(request.contextId);
      default:
        return { type: "error", content: `Unknown request type: ${request.type}` };
    }
  }

  async steer(message: string): Promise<string> {
    // Queue a steering message to be injected after current turn
    this.agent.steer({
      role: "user",
      content: message,
      timestamp: Date.now(),
    } as AgentMessage);
    return "Steering message queued";
  }

  async getContext(): Promise<AgentContextData> {
    // Get current context from KV
    const stateJson = await this.env.AGENT_STATE.get(this.currentContextId);
    const state = stateJson ? JSON.parse(stateJson) : { messages: [] };
    
    return {
      id: this.currentContextId,
      messages: state.messages || [],
      createdAt: state.createdAt || Date.now(),
    };
  }

  async createContext(parentId?: string): Promise<AgentContextData> {
    const contextId = crypto.randomUUID();
    const context: AgentContextData = {
      id: contextId,
      parentId,
      messages: [],
      createdAt: Date.now(),
    };

    // Store in KV
    await this.env.AGENT_STATE.put(contextId, JSON.stringify(context));

    return context;
  }

  async getTools(): Promise<AgentTool[]> {
    return this.tools;
  }

  private async handlePrompt(content: string): Promise<ChatResponse> {
    // Load existing context from KV into agent state before prompting
    const context = await this.getContext();
    this.agent.state.messages = [...context.messages];

    // Capture text from both streaming updates and final messages. Some providers
    // do not populate the final message exactly the same way, so keep a robust
    // fallback instead of returning a misleading "No response received".
    let finalResponse = "";
    let finalUsage: Usage | undefined;
    let turnCount = 0;

    const captureAssistantMessage = (message: AgentMessage | undefined): void => {
      if (message?.role !== "assistant") return;

      const text = this.extractAssistantText(message);
      if (text) {
        finalResponse = text;
      }
      finalUsage = message.usage;
    };

    const unsubscribe = this.agent.subscribe(async (event) => {
      if (event.type === "turn_start") {
        turnCount++;
        console.log(`[AGENT] Turn ${turnCount} started`);
      }

      if (event.type === "message_update") {
        const assistantEvent = event.assistantMessageEvent;
        if (assistantEvent.type === "text_delta") {
          finalResponse += assistantEvent.delta;
        } else if (assistantEvent.type === "text_end") {
          finalResponse = assistantEvent.content;
        }
        captureAssistantMessage(event.message);
      }

      if (event.type === "message_end") {
        captureAssistantMessage(event.message);
      }

      if (event.type === "agent_end") {
        captureAssistantMessage(this.findLastAssistantMessage(event.messages));
        // Save updated messages back to KV after the agent finishes
        await this.saveContext();
      }
    });

    // Cloudflare Workers have a 30-second HTTP timeout.
    // Set a slightly shorter timeout to ensure we can return a proper error message.
    const WORKER_TIMEOUT_MS = 28000; // 28 seconds
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    try {
      // Create a timeout promise that rejects if execution takes too long
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error(`Request timed out after ${WORKER_TIMEOUT_MS / 1000}s. The agent took too many turns (${turnCount} completed). Cloudflare Workers have a 30s HTTP timeout - consider using WebSockets for complex multi-turn operations.`));
        }, WORKER_TIMEOUT_MS);
      });

      // Run the agent with the prompt, racing against timeout
      const promptPromise = this.agent.prompt(content);
      await Promise.race([promptPromise, timeoutPromise]);

      // Wait for the agent to complete (also with timeout protection)
      const idlePromise = this.agent.waitForIdle();
      await Promise.race([idlePromise, timeoutPromise]);

      // Clear timeout since we completed successfully
      if (timeoutHandle) clearTimeout(timeoutHandle);

      const lastAssistant = this.findLastAssistantMessage(this.agent.state.messages);
      captureAssistantMessage(lastAssistant);

      const errorMessage = this.agent.state.errorMessage || lastAssistant?.errorMessage;
      if (!finalResponse && errorMessage) {
        return {
          type: "error",
          content: `Error: ${errorMessage}`,
          contextId: this.currentContextId,
          usage: finalUsage,
        };
      }

      return {
        type: "message",
        content: finalResponse || "(No response received)",
        contextId: this.currentContextId,
        usage: finalUsage,
      };
    } catch (error) {
      // Clear timeout if it hasn't fired yet
      if (timeoutHandle) clearTimeout(timeoutHandle);
      
      // Abort the agent to stop any ongoing work
      try {
        this.agent.abort();
      } catch {
        // Ignore abort errors
      }
      
      console.error("Prompt error:", error);
      return {
        type: "error",
        content: `Error: ${error instanceof Error ? error.message : String(error)}`,
        contextId: this.currentContextId,
      };
    } finally {
      unsubscribe();
    }
  }

  private extractAssistantText(message: AgentMessage): string {
    if (message.role !== "assistant" || !Array.isArray(message.content)) {
      return "";
    }

    return message.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("");
  }

  private findLastAssistantMessage(messages: AgentMessage[]): Extract<AgentMessage, { role: "assistant" }> | undefined {
    return messages
      .slice()
      .reverse()
      .find((message): message is Extract<AgentMessage, { role: "assistant" }> => message.role === "assistant");
  }

  private async saveContext(): Promise<void> {
    const context: AgentContextData = {
      id: this.currentContextId,
      messages: this.agent.state.messages,
      createdAt: Date.now(),
    };
    await this.env.AGENT_STATE.put(this.currentContextId, JSON.stringify(context));
  }

  private async handleSteer(content: string): Promise<ChatResponse> {
    this.agent.steer({
      role: "user",
      content,
      timestamp: Date.now(),
    } as AgentMessage);

    return {
      type: "message",
      content: "Steering message queued",
      contextId: this.currentContextId,
    };
  }

  private async handleFork(requestedContextId?: string): Promise<ChatResponse> {
    // Switch to requested context if provided, otherwise use current
    if (requestedContextId) {
      this.currentContextId = requestedContextId;
    }
    
    // Fork the current context
    const currentContext = await this.getContext();
    const newContext = await this.createContext(currentContext.id);

    // Copy messages to new context
    newContext.messages = [...currentContext.messages];
    await this.env.AGENT_STATE.put(newContext.id, JSON.stringify(newContext));

    this.currentContextId = newContext.id;

    return {
      type: "context_update",
      content: `Forked to new context: ${newContext.id}`,
      contextId: newContext.id,
    };
  }

  private async handleNewContext(_parentId?: string): Promise<ChatResponse> {
    const context = await this.createContext(_parentId);
    this.currentContextId = context.id;

    return {
      type: "context_update",
      content: `Created new context: ${context.id}`,
      contextId: context.id,
    };
  }
}

// Create the agent instance
export async function createAgent(env: Env, ctx?: ExecutionContext): Promise<ClawflareAgentWrapper> {
  console.log("[createAgent] Starting agent creation...");
  
  const { provider, modelId, model } = resolveConfiguredModel(env);
  
  console.log(`[AGENT] Using provider: ${provider}, model: ${modelId}`);
  console.log(`[AGENT] MOCK_AI: ${env.MOCK_AI}`);

  // Get API key/bearer token for the selected provider from Worker env bindings.
  // pi-ai's process.env helper is not reliable inside Cloudflare Workers.
  const getApiKey = (requestedProvider?: string): Promise<string | undefined> => {
    return Promise.resolve(getApiKeyForProvider(env, requestedProvider || provider));
  };

  // Create tools
  console.log("[createAgent] Creating tools...");
  const tools = createTools(env, ctx);
  console.log(`[createAgent] Created ${tools.length} tools`);

  // Check mock mode
  const useMock = shouldUseMockAI(env);
  console.log(`[AGENT] Using mock AI: ${useMock}`);

  const streamFn = useMock
    ? createMockStream()
    : provider === "amazon-bedrock"
      ? await createBedrockStreaming(env)
      : streamSimple;

  if (useMock) {
    console.log("[AGENT] Using mock AI mode");
  } else {
    console.log(`[AGENT] Using ${provider} streaming`);
  }

  // Create the pi-agent-core Agent
  console.log("[createAgent] Creating Agent instance...");
  const agent = new Agent({
    getApiKey,
    streamFn: streamFn as typeof streamSimple,
    initialState: {
      systemPrompt: getSystemPrompt(),
      model,
      tools,
    },
  });
  console.log("[createAgent] Agent created successfully");

  return new ClawflareAgentWrapper(agent, env, tools);
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

// Create Bedrock streaming function.
async function createBedrockStreaming(
  env: Env,
): Promise<typeof streamSimple> {
  console.log("[createBedrockStreaming] Loading Bedrock module...");
  const bedrockModule = await getBedrockModule();
  if (!bedrockModule) {
    throw new Error("Failed to load Bedrock module");
  }
  const { bedrockProviderModule } = bedrockModule;
  const { streamBedrock } = bedrockProviderModule;
  console.log("[createBedrockStreaming] Bedrock module loaded successfully");

  const bearerToken = normalizeBedrockBearerToken(env.AWS_BEARER_TOKEN_BEDROCK);
  if (!bearerToken && !env.AWS_PROFILE) {
    throw new Error(
      "AWS_BEARER_TOKEN_BEDROCK is not configured. Set it with: cd packages/harness && npx wrangler secret put AWS_BEARER_TOKEN_BEDROCK"
    );
  }

  return ((m: Model<"bedrock-converse-stream">, ctx: Parameters<typeof streamSimple>[1], opts?: BedrockOptions) => {
    console.log(`[createBedrockStreaming] Calling streamBedrock with token configured: ${!!bearerToken}, token length: ${bearerToken?.length || 0}`);
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

// DEPRECATED: Generic createStreamingFunction removed

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
