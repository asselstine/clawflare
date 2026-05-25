// Clawflare Runtime Configuration API
// Configuration types and factory for user-defined customization

import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { EgressHandler, EgressRegistry } from "@clawflare/egress-core";
import type { Env } from "./internal-types/index.js";
import type { ToolContext } from "./tools/index.js";
import { handleHttpRequest } from "./http/router.js";
import { createEgressRegistry as createBaseEgressRegistry } from "./egress/registry.js";
import { getConfigServerNames } from "./server-names.js";

// =============================================================================
// Configuration Types
// =============================================================================

/**
 * AI provider configuration
 */
export interface AiConfig {
  provider?: string;
  model?: string;
}

/**
 * Cloudflare-specific configuration
 */
export interface CloudflareConfig {
  compatibilityDate?: string;
  workerName?: string;
  workflowName?: string;
}

/**
 * Secret specification for deployment
 */
export interface SecretSpec {
  name: string;
  required?: boolean;
  description?: string;
}

/**
 * Tool factory function type - supports optional tool context
 */
export type ToolFactory = (env: Env, ctx?: ExecutionContext, toolCtx?: ToolContext) => AgentTool | AgentTool[];

/**
 * Egress handler factory function type
 */
export type EgressHandlerFactory = () => EgressHandler | EgressHandler[];

/**
 * Clawflare plugin interface
 */
export interface ClawflarePlugin {
  name: string;
  registerTools?: (env: Env, ctx?: ExecutionContext, toolCtx?: ToolContext) => AgentTool | AgentTool[];
  registerEgress?: () => EgressHandler | EgressHandler[];
}

/**
 * Complete Clawflare configuration
 */
export interface ClawflareConfig {
  name: string;
  ai?: AiConfig;
  plugins?: ClawflarePlugin[];
  tools?: ToolFactory[];
  egressHandlers?: EgressHandlerFactory[];
  secrets?: SecretSpec[];
  cloudflare?: CloudflareConfig;
}

// =============================================================================
// Global Runtime State (Module-Level Singleton)
// =============================================================================

// Module-level storage for runtime configuration
// This works because all code (Worker, DO, Workflow) runs in the same bundle/isolate
let activeConfig: ClawflareConfig | undefined;
let activeNormalizedConfig: Required<ClawflareConfig> | undefined;

/**
 * Set the runtime configuration. Called once when the Worker is initialized.
 * This stores config in module-level variables accessible from DOs and Workflows.
 */
export function setRuntimeConfig(config: ClawflareConfig): void {
  activeConfig = config;
  activeNormalizedConfig = normalizeConfig(config);
}

/**
 * Get the current runtime configuration (from any execution context)
 */
export function getRuntimeConfig(): ClawflareConfig | undefined {
  return activeConfig;
}

/**
 * Get the normalized runtime configuration
 */
export function getNormalizedRuntimeConfig(): Required<ClawflareConfig> | undefined {
  return activeNormalizedConfig;
}

// =============================================================================
// Config Factory
// =============================================================================

/**
 * Define a Clawflare configuration.
 * This is a typed identity function that provides a stable API.
 */
export function defineClawflareConfig(config: ClawflareConfig): ClawflareConfig {
  return config;
}

/**
 * Normalize and validate configuration
 */
export function normalizeConfig(config: ClawflareConfig): Required<ClawflareConfig> {
  const runtimeNames = getConfigServerNames(config);

  return {
    name: config.name,
    ai: {
      provider: config.ai?.provider ?? "amazon-bedrock",
      model: config.ai?.model ?? "minimax.minimax-m2.5",
    },
    plugins: config.plugins ?? [],
    tools: config.tools ?? [],
    egressHandlers: config.egressHandlers ?? [],
    secrets: config.secrets ?? [],
    cloudflare: {
      compatibilityDate: config.cloudflare?.compatibilityDate ?? "2025-01-01",
      workerName: runtimeNames.workerName,
      workflowName: runtimeNames.workflowName,
    },
  };
}

// =============================================================================
// Tool Extension API
// =============================================================================

/**
 * Extract user-defined tools from the config
 */
function extractUserTools(config: ClawflareConfig): ToolFactory[] {
  const toolFactories: ToolFactory[] = [];

  // Collect tools from plugins
  for (const plugin of config.plugins ?? []) {
    if (plugin.registerTools) {
      toolFactories.push(plugin.registerTools);
    }
  }

  // Collect direct tool factories
  for (const factory of config.tools ?? []) {
    toolFactories.push(factory);
  }

  return toolFactories;
}

/**
 * Create user tools from config at runtime
 */
export function createUserTools(
  config: ClawflareConfig,
  env: Env,
  ctx?: ExecutionContext
): AgentTool[] {
  const toolFactories = extractUserTools(config);
  const tools: AgentTool[] = [];

  for (const factory of toolFactories) {
    const result = factory(env, ctx);
    const factoryTools = Array.isArray(result) ? result : [result];
    tools.push(...factoryTools);
  }

  return tools;
}

// =============================================================================
// Egress Extension API
// =============================================================================

/**
 * Extract user-defined egress handlers from the config
 */
function extractUserEgressHandlers(config: ClawflareConfig): EgressHandlerFactory[] {
  const handlerFactories: EgressHandlerFactory[] = [];

  // Collect handlers from plugins
  for (const plugin of config.plugins ?? []) {
    if (plugin.registerEgress) {
      handlerFactories.push(plugin.registerEgress);
    }
  }

  // Collect direct handler factories
  for (const factory of config.egressHandlers ?? []) {
    handlerFactories.push(factory);
  }

  return handlerFactories;
}

/**
 * Create the egress registry with built-in and user-defined handlers
 */
export function createEgressRegistryWithConfig(
  config: ClawflareConfig
): EgressRegistry {
  // Start with built-in registry (GitHub, Cloudflare)
  const registry = createBaseEgressRegistry();

  // Add user-defined handlers from config
  const handlerFactories = extractUserEgressHandlers(config);

  for (const factory of handlerFactories) {
    const result = factory();
    const handlers = Array.isArray(result) ? result : [result];
    for (const handler of handlers) {
      registry.register(handler);
    }
  }

  return registry;
}

// =============================================================================
// Worker Factory
// =============================================================================

/**
 * Clawflare Worker entrypoint interface
 */
export interface ClawflareWorker {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response>;
}

/**
 * Create a Clawflare Worker from configuration.
 * This is the main entry point for user projects.
 */
export function createClawflareWorker(config: ClawflareConfig): ClawflareWorker {
  // Store config in module-level singleton so it's accessible from DOs and Workflows
  setRuntimeConfig(config);

  // Ensure normalized config is available
  void normalizeConfig(config);

  return {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
      // Apply config overrides to env if needed
      const envRecord = env as unknown as Record<string, string>;
      if (config.ai?.provider && !envRecord.AI_PROVIDER) {
        envRecord.AI_PROVIDER = config.ai.provider;
      }
      if (config.ai?.model && !envRecord.AI_MODEL) {
        envRecord.AI_MODEL = config.ai.model;
      }

      // Delegate to the standard HTTP handler
      return handleHttpRequest(request, env, ctx);
    },
  };
}

// =============================================================================
// Egress Handler Factory
// =============================================================================

/**
 * Define a custom egress handler using the standard HTTP egress handler pattern.
 * This is a helper that wraps @clawflare/egress-core's defineHttpEgressHandler.
 */
export interface DefineEgressHandlerConfig<Env = unknown> {
  name: string;
  description: string;
  domains: string[];
  /**
   * Decorates headers before the request is made
   */
  decorateHeaders?: (headers: Headers, request: Request, context: {
    env: Env;
    handlerConfig?: unknown;
    requestId?: string;
  }) => void | Promise<void>;
}
