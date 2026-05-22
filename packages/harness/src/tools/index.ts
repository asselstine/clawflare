// Tools for the Clawflare Agent
// Model-visible tools including code execution and container filesystem operations

import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { Static, TSchema } from "@earendil-works/pi-ai";
import type { Env } from "./../internal-types/index.js";
import type { ExecutionResult } from "./../internal-types/tools.js";
import { getDataLayer } from "../data/index.js";
import { executeDynamicWorker, USER_FUNCTION_CONTRACT } from "./dynamic-worker";
import { createContainerTools } from "../container/tools.js";

// Tool parameter types
interface StoreCodeParams {
  name: string;
  description?: string;
  code: string;
}

interface ExecuteStoredCodeParams {
  name: string;
  description?: string;
  input?: unknown;
  maxResponseLength?: number;
}

interface ExecuteCodeParams {
  code: string;
  description?: string;
  input?: unknown;
  maxResponseLength?: number;
}

interface SearchParams {
  collection?: "stored_code" | "egress_handlers" | "all";
  query?: string;
  limit?: number;
}

export const MAX_TOOL_RESPONSE_LENGTH_CHARS = 1_000_000;
export const DEFAULT_TOOL_RESPONSE_LENGTH_CHARS = 8_000;

// Name validation - conservative pattern
const VALID_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

function validateName(name: string): void {
  if (!VALID_NAME_PATTERN.test(name)) {
    throw new Error(
      `Invalid name "${name}". Names must match pattern: ${VALID_NAME_PATTERN.source}`
    );
  }
}

/**
 * Context passed to user-defined tools
 */
export interface UserToolContext {
  env: Env;
  ctx?: ExecutionContext;
  sessionId?: string;
  logger: Console;
}

/**
 * Tool definition for user-defined tools
 */
export interface UserToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (params: unknown, context: UserToolContext) => Promise<unknown> | unknown;
}

/**
 * Define a custom tool using a simple API.
 * This wraps the lower-level AgentTool interface for easier use.
 */
export function defineTool(def: UserToolDefinition): ToolFactory {
  return {
    name: def.name,
    description: def.description,
    parameters: def.parameters,
    def,
  };
}

export interface ToolContext {
  sessionId?: string;
}

/**
 * Internal factory representation for user tools
 */
export interface ToolFactory {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  def: UserToolDefinition;
}

/**
 * Create AgentTool instances from user tool definitions.
 * This is used internally to convert user tools to runtime tools.
 */
export function createAgentToolsFromUserDefs(
  toolFactories: ToolFactory[],
  env: Env,
  ctx?: ExecutionContext,
  toolCtx?: ToolContext
): AgentTool[] {
  const context: UserToolContext = {
    env,
    ctx,
    sessionId: toolCtx?.sessionId,
    logger: console,
  };

  return toolFactories.map((factory): AgentTool => {
    const schema = factory.parameters as TSchema;
    
    return {
      name: factory.name,
      description: factory.description,
      label: factory.name,
      parameters: schema,
      execute: async (
        _toolCallId: string,
        params: Static<TSchema>
      ): Promise<AgentToolResult<unknown>> => {
        const result = await factory.def.execute(params, context);
        
        // Handle result normalization
        if (result === undefined || result === null) {
          return {
            content: [{ type: "text", text: "" }],
            details: {},
          };
        }
        
        // If result is already a string, use it directly
        if (typeof result === "string") {
          return {
            content: [{ type: "text", text: result }],
            details: { result },
          };
        }
        
        // Otherwise, serialize as JSON
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          details: { result },
        };
      },
    };
  });
}

export function createTools(env: Env, ctx?: ExecutionContext, toolCtx?: ToolContext): AgentTool[] {
  const baseTools: AgentTool[] = [
    createStoreCodeTool(env),
    createExecuteStoredCodeTool(env, ctx),
    createExecuteCodeTool(env, ctx),
    createSearchTool(env),
  ];
  
  // Add container tools if session ID is available
  if (toolCtx?.sessionId) {
    const containerTools = createContainerTools(env, { sessionId: toolCtx.sessionId });
    return [...baseTools, ...containerTools];
  }
  
  return baseTools;
}

// Tool: Store code for later execution
function createStoreCodeTool(env: Env): AgentTool {
  return {
    name: "store_code",
    description:
      `Store JavaScript code by name for later execution. Use this to save reusable code snippets. Stored code must follow this contract: ${USER_FUNCTION_CONTRACT}`,
    label: "Store Code",
    parameters: Type.Object({
      name: Type.String({ description: "Name for the code (alphanumeric, hyphens, underscores)" }),
      description: Type.Optional(Type.String({ description: "Description of what the code does" })),
      code: Type.String({ description: `JavaScript ES module to store. ${USER_FUNCTION_CONTRACT}` }),
    }) as TSchema,
    execute: async (
      _toolCallId: string,
      params: Static<TSchema>,
      _signal?: AbortSignal
    ): Promise<AgentToolResult<unknown>> => {
      const p = params as StoreCodeParams;

      validateName(p.name);

      const data = getDataLayer(env);
      await data.storedCode.upsert({
        name: p.name,
        description: p.description || "",
        code: p.code,
      });

      return {
        content: [{ type: "text", text: `Stored code "${p.name}".` }],
        details: { name: p.name, description: p.description },
      };
    },
  };
}

// Tool: Execute previously stored code
function createExecuteStoredCodeTool(env: Env, ctx?: ExecutionContext): AgentTool {
  return {
    name: "execute_stored_code",
    description:
      `Execute previously stored JavaScript code by name. The code runs in an isolated Dynamic Worker. Stored code must follow this contract: ${USER_FUNCTION_CONTRACT}`,
    label: "Execute Stored Code",
    parameters: Type.Object({
      name: Type.String({ description: "Name of the stored code to execute" }),
      description: Type.Optional(Type.String({ description: "Brief description of this execution (80 chars max)" })),
      input: Type.Optional(Type.Unknown({ description: "Input data to pass to the code" })),
      maxResponseLength: Type.Optional(Type.Number({
        description: "Maximum response characters to return to the agent. Output is tailed when truncated. Hard cap: 1,000,000.",
        minimum: 1,
        maximum: MAX_TOOL_RESPONSE_LENGTH_CHARS,
      })),
    }) as TSchema,
    execute: async (
      _toolCallId: string,
      params: Static<TSchema>,
      _signal?: AbortSignal
    ): Promise<AgentToolResult<unknown>> => {
      const p = params as ExecuteStoredCodeParams;

      validateName(p.name);

      const data = getDataLayer(env);
      const stored = await data.storedCode.get(p.name);

      if (!stored) {
        throw new Error(`Code "${p.name}" not found. Use store_code to save it first.`);
      }

      const result = await executeDynamicWorker(env, ctx, stored.code, p.input);

      return formatExecutionResult(result, {
        maxResponseLength: p.maxResponseLength,
        executedCode: stored.code,
      });
    },
  };
}

// Tool: Execute code inline
function createExecuteCodeTool(env: Env, ctx?: ExecutionContext): AgentTool {
  return {
    name: "execute_code",
    description:
      `Execute JavaScript code in an isolated Dynamic Worker. Code must follow this contract: ${USER_FUNCTION_CONTRACT}`,
    label: "Execute Code",
    parameters: Type.Object({
      code: Type.String({ description: `JavaScript ES module to execute. ${USER_FUNCTION_CONTRACT}` }),
      description: Type.Optional(Type.String({ description: "Brief description of what the code does (80 chars max)" })),
      input: Type.Optional(Type.Unknown({ description: "Input data to pass to the code" })),
      maxResponseLength: Type.Optional(Type.Number({
        description: "Maximum response characters to return to the agent. Output is tailed when truncated. Hard cap: 1,000,000.",
        minimum: 1,
        maximum: MAX_TOOL_RESPONSE_LENGTH_CHARS,
      })),
    }) as TSchema,
    execute: async (
      _toolCallId: string,
      params: Static<TSchema>,
      _signal?: AbortSignal
    ): Promise<AgentToolResult<unknown>> => {
      const p = params as ExecuteCodeParams;

      const result = await executeDynamicWorker(env, ctx, p.code, p.input);

      return formatExecutionResult(result, { maxResponseLength: p.maxResponseLength });
    },
  };
}

// Tool: Search stored code and egress handlers
function createSearchTool(env: Env): AgentTool {
  return {
    name: "search",
    description:
      "Search stored code and egress handlers. Use this to find reusable code or discover domain-specific egress handlers that provide enhanced authentication/capabilities for outbound HTTP requests.",
    label: "Search",
    parameters: Type.Object({
      collection: Type.Optional(
        Type.Union(
          [
            Type.Literal("stored_code", { description: "Search stored code only" }),
            Type.Literal("egress_handlers", { description: "Search egress handlers only" }),
            Type.Literal("all", { description: "Search both collections" }),
          ],
          { description: "Collection to search" }
        )
      ),
      query: Type.Optional(Type.String({ description: "Search query string. Supports * as wildcard (e.g., *github.com). Use * alone to list all." })),
      limit: Type.Optional(Type.Number({ description: "Maximum results to return (max 20)" })),
    }) as TSchema,
    execute: async (
      _toolCallId: string,
      params: Static<TSchema>,
      _signal?: AbortSignal
    ): Promise<AgentToolResult<unknown>> => {
      const p = params as SearchParams;

      const collection = p.collection || "all";
      const limit = Math.min(p.limit || 20, 20); // Cap at 20

      const data = getDataLayer(env);

      let results: { storedCode: import("../data/index.js").StoredCodeEntry[]; egressHandlers: import("../data/index.js").EgressHandlerMetadata[] };

      if (collection === "stored_code") {
        results = {
          storedCode: await data.storedCode.search(p.query ?? "*", limit),
          egressHandlers: [],
        };
      } else if (collection === "egress_handlers") {
        results = {
          storedCode: [],
          egressHandlers: await data.egressHandlers.search(p.query ?? "*", limit),
        };
      } else {
        results = await data.search(p.query ?? "*", limit);
      }

      const lines: string[] = [];

      if (collection === "stored_code" || collection === "all") {
        lines.push(`Stored Code (${results.storedCode.length}):`);
        for (const code of results.storedCode) {
          lines.push(`  - ${code.name}: ${code.description || "(no description)"}`);
          lines.push(`    updated: ${new Date(code.updatedAt).toISOString()}`);
        }
        if (results.storedCode.length === 0) {
          lines.push("  (none found)");
        }
      }

      if (collection === "egress_handlers" || collection === "all") {
        lines.push(`Egress Handlers (${results.egressHandlers.length}):`);
        for (const handler of results.egressHandlers) {
          lines.push(`  - ${handler.name}: ${handler.description || "(no description)"}`);
          lines.push(`    enabled: ${handler.enabled}`);
          lines.push(`    domains: ${handler.domains.join(", ")}`);
        }
        if (results.egressHandlers.length === 0) {
          lines.push("  (none found)");
        }
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: results,
      };
    },
  };
}

interface FormatExecutionOptions {
  maxResponseLength?: number;
  executedCode?: string;
}

interface TruncatedOutput {
  text: string;
  truncated: boolean;
  originalLength: number;
  limit: number;
}

function responseLengthLimit(maxResponseLength: number | undefined): number {
  if (maxResponseLength === undefined) return DEFAULT_TOOL_RESPONSE_LENGTH_CHARS;
  if (!Number.isFinite(maxResponseLength) || maxResponseLength < 1) {
    throw new Error("maxResponseLength must be a positive number");
  }
  return Math.min(Math.floor(maxResponseLength), MAX_TOOL_RESPONSE_LENGTH_CHARS);
}

function tailToolOutput(text: string, limit: number): TruncatedOutput {
  if (text.length <= limit) {
    return { text, truncated: false, originalLength: text.length, limit };
  }

  const prefix = `[Tool output truncated. Showing the tail of the response. Original length: ${text.length} characters. Limit: ${limit} characters.]\n`;
  const tailLength = Math.max(0, limit - prefix.length);
  return {
    text: `${prefix}${text.slice(-tailLength)}`,
    truncated: true,
    originalLength: text.length,
    limit,
  };
}

// Format execution result for the agent
export function formatExecutionResult(
  result: ExecutionResult,
  options: FormatExecutionOptions = {},
): AgentToolResult<unknown> {
  const limit = responseLengthLimit(options.maxResponseLength);

  if (result.ok) {
    const parts: string[] = [];
    if (result.stdout) parts.push(`Stdout:\n${result.stdout}`);
    if (result.stderr) parts.push(`Stderr:\n${result.stderr}`);
    if (result.result !== undefined) parts.push(`Result: ${JSON.stringify(result.result, null, 2)}`);

    const text = parts.length > 0 ? parts.join("\n\n") : "Code executed successfully.";
    const output = tailToolOutput(text, limit);

    return {
      content: [{ type: "text", text: output.text }],
      details: {
        ok: true,
        truncated: output.truncated,
        originalLength: output.originalLength,
        limit: output.limit,
        ...(options.executedCode === undefined ? {} : { executedCode: options.executedCode }),
      },
    };
  } else {
    const parts: string[] = [result.error ? `Error: ${result.error}` : "Unknown error during execution."];
    if (result.stdout) parts.push(`Stdout:\n${result.stdout}`);
    if (result.stderr) parts.push(`Stderr:\n${result.stderr}`);

    const output = tailToolOutput(parts.join("\n\n"), limit);
    return {
      content: [{ type: "text", text: output.text }],
      details: {
        ok: false,
        truncated: output.truncated,
        originalLength: output.originalLength,
        limit: output.limit,
        ...(options.executedCode === undefined ? {} : { executedCode: options.executedCode }),
      },
    };
  }
}
