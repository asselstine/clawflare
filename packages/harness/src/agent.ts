// Clawflare Agent - Uses pi-agent-core for context management
// This provides the agent logic that handles prompts, tools, and context

import { Agent, type AgentTool, type AgentMessage } from "@earendil-works/pi-agent-core";
import { getModel, streamSimple, type Model, type BedrockOptions } from "@earendil-works/pi-ai";
import type { Env, ChatRequest, ChatResponse, AgentContextData } from "./types";
import { createTools, setCloudflareToken, setCloudflareAccountId } from "./tools";
import { createMockStream, shouldUseMockAI } from "./mock-ai";

// Default provider and model configuration
// Tree-shaking: These are inlined for esbuild define substitution
const DEFAULT_PROVIDER: "amazon-bedrock" = "amazon-bedrock";
const DEFAULT_MODEL_ID: "minimax.minimax-m2.5" = "minimax.minimax-m2.5";

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
    const state = stateJson ? JSON.parse(stateJson) : { messages: [], skills: [] };
    
    return {
      id: this.currentContextId,
      messages: state.messages || [],
      skills: state.skills || [],
      createdAt: state.createdAt || Date.now(),
    };
  }

  async createContext(parentId?: string): Promise<AgentContextData> {
    const contextId = crypto.randomUUID();
    const context: AgentContextData = {
      id: contextId,
      parentId,
      messages: [],
      skills: [],
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

    // Set up a promise to capture the final response
    let finalResponse = "";

    const unsubscribe = this.agent.subscribe(async (event) => {
      if (event.type === "message_end") {
        // Get the complete message from the event
        const lastMessage = event.message;
        if (lastMessage && lastMessage.role === "assistant" && Array.isArray(lastMessage.content)) {
          finalResponse = lastMessage.content
            .filter((c): c is { type: "text"; text: string } => c.type === "text")
            .map(c => c.text)
            .join("");
        }
      }
      if (event.type === "agent_end") {
        // Save updated messages back to KV after the agent finishes
        await this.saveContext();
      }
    });

    try {
      // Run the agent with the prompt
      await this.agent.prompt(content);

      // Wait for the agent to complete
      await this.agent.waitForIdle();

      return {
        type: "message",
        content: finalResponse || "(No response received)",
        contextId: this.currentContextId,
      };
    } catch (error) {
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

  private async saveContext(): Promise<void> {
    const context: AgentContextData = {
      id: this.currentContextId,
      messages: this.agent.state.messages,
      skills: [],
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
export async function createAgent(env: Env): Promise<ClawflareAgentWrapper> {
  console.log("[createAgent] Starting agent creation...");
  
  // Set the Cloudflare token for tools
  console.log("[createAgent] Setting Cloudflare token...");
  setCloudflareToken(env.CLOUDFLARE_API_TOKEN);
  
  // Set the Cloudflare account ID for tools
  console.log("[createAgent] Setting Cloudflare account ID...");
  setCloudflareAccountId(env.CLOUDFLARE_ACCOUNT_ID);

  // Get provider and model from environment or use defaults
  const provider = env.AI_PROVIDER || DEFAULT_PROVIDER;
  const modelId = env.AI_MODEL || DEFAULT_MODEL_ID;
  
  console.log(`[AGENT] Using provider: ${provider}, model: ${modelId}`);
  console.log(`[AGENT] MOCK_AI: ${env.MOCK_AI}`);
  
  // Tree-shaking: Provider is always "amazon-bedrock" via define substitution
  // This allows esbuild to eliminate unreachable code branches for other providers
  const PROVIDER: "amazon-bedrock" = "amazon-bedrock";
  const MODEL_ID: "minimax.minimax-m2.5" = "minimax.minimax-m2.5";
  
  console.log("[createAgent] Getting model...");
  const model = getModel(PROVIDER, MODEL_ID);
  if (!model) {
    throw new Error(`Model not found: ${provider}/${modelId}`);
  }
  console.log("[createAgent] Model retrieved successfully");

  // Get API key/bearer token for the provider
  const getApiKey = (): Promise<string> => {
    // Always Bedrock bearer token - provider is statically known
    return Promise.resolve(env.AWS_BEARER_TOKEN_BEDROCK || env.CLOUDFLARE_API_TOKEN || "");
  };

  // Create tools
  console.log("[createAgent] Creating tools...");
  const tools = createTools();
  console.log(`[createAgent] Created ${tools.length} tools`);

  // Check mock mode
  const useMock = shouldUseMockAI(env);
  console.log(`[AGENT] Using mock AI: ${useMock}`);

  // Tree-shaking: Static provider path eliminates dead code for other providers
  const streamFn = useMock ? createMockStream() : await createBedrockStreaming(env);

  if (useMock) {
    console.log("[AGENT] Using mock AI mode");
  } else {
    console.log("[AGENT] Using Amazon Bedrock streaming");
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

// Create Bedrock streaming function - static path for tree-shaking
// This eliminates code paths for other providers that are never used
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

  return ((m: Model<"bedrock-converse-stream">, ctx: Parameters<typeof streamSimple>[1], opts?: BedrockOptions) => {
    const bearerToken = env.AWS_BEARER_TOKEN_BEDROCK || env.CLOUDFLARE_API_TOKEN || "";
    console.log(`[createBedrockStreaming] Calling streamBedrock with token configured: ${bearerToken.length > 0}`);
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

You can:
- Create and deploy new Cloudflare Workers
- Execute code in dynamic workers
- Manage Cloudflare resources (D1, KV, R2, etc.)
- Store and retrieve skills from the skills store

When you need to create a new tool, use the deploy_tool tool.
When you need to execute code, use the execute_code tool.

Be helpful, concise, and focus on getting tasks done efficiently.`;
}
