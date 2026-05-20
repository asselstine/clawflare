// Tools for the Clawflare Agent
// These are the only four model-visible tools

import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { Static, TSchema } from "@earendil-works/pi-ai";
import type { Env } from "./../internal-types/index.js";
import type { ExecutionResult } from "./../internal-types/tools.js";
import { getDatastore } from "../datastore";
import { executeDynamicWorker } from "../runtime/dynamic-worker";

// Tool parameter types
interface StoreCodeParams {
  name: string;
  description?: string;
  code: string;
}

interface ExecuteStoredCodeParams {
  name: string;
  input?: unknown;
}

interface ExecuteCodeParams {
  code: string;
  input?: unknown;
}

interface SearchParams {
  collection?: "stored_code" | "egress_handlers" | "all";
  query?: string;
  limit?: number;
}

// Name validation - conservative pattern
const VALID_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

function validateName(name: string): void {
  if (!VALID_NAME_PATTERN.test(name)) {
    throw new Error(
      `Invalid name "${name}". Names must match pattern: ${VALID_NAME_PATTERN.source}`
    );
  }
}

export function createTools(env: Env, ctx?: ExecutionContext): AgentTool[] {
  return [
    createStoreCodeTool(env),
    createExecuteStoredCodeTool(env, ctx),
    createExecuteCodeTool(env, ctx),
    createSearchTool(env),
  ];
}

// Tool: Store code for later execution
function createStoreCodeTool(env: Env): AgentTool {
  return {
    name: "store_code",
    description:
      "Store JavaScript code by name for later execution. Use this to save reusable code snippets.",
    label: "Store Code",
    parameters: Type.Object({
      name: Type.String({ description: "Name for the code (alphanumeric, hyphens, underscores)" }),
      description: Type.Optional(Type.String({ description: "Description of what the code does" })),
      code: Type.String({ description: "JavaScript code to store" }),
    }) as TSchema,
    execute: async (
      _toolCallId: string,
      params: Static<TSchema>,
      _signal?: AbortSignal
    ): Promise<AgentToolResult<unknown>> => {
      const p = params as StoreCodeParams;

      validateName(p.name);

      const datastore = getDatastore(env);
      await datastore.upsertStoredCode({
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
      "Execute previously stored JavaScript code by name. The code runs in an isolated Dynamic Worker.",
    label: "Execute Stored Code",
    parameters: Type.Object({
      name: Type.String({ description: "Name of the stored code to execute" }),
      input: Type.Optional(Type.Unknown({ description: "Input data to pass to the code" })),
    }) as TSchema,
    execute: async (
      _toolCallId: string,
      params: Static<TSchema>,
      _signal?: AbortSignal
    ): Promise<AgentToolResult<unknown>> => {
      const p = params as ExecuteStoredCodeParams;

      validateName(p.name);

      const datastore = getDatastore(env);
      const stored = await datastore.getStoredCode(p.name);

      if (!stored) {
        throw new Error(`Code "${p.name}" not found. Use store_code to save it first.`);
      }

      const result = await executeDynamicWorker(env, ctx, stored.code, p.input);

      return formatExecutionResult(result);
    },
  };
}

// Tool: Execute code inline
function createExecuteCodeTool(env: Env, ctx?: ExecutionContext): AgentTool {
  return {
    name: "execute_code",
    description:
      "Execute JavaScript code in an isolated Dynamic Worker.",
    label: "Execute Code",
    parameters: Type.Object({
      code: Type.String({ description: "JavaScript code to execute" }),
      input: Type.Optional(Type.Unknown({ description: "Input data to pass to the code" })),
    }) as TSchema,
    execute: async (
      _toolCallId: string,
      params: Static<TSchema>,
      _signal?: AbortSignal
    ): Promise<AgentToolResult<unknown>> => {
      const p = params as ExecuteCodeParams;

      const result = await executeDynamicWorker(env, ctx, p.code, p.input);

      return formatExecutionResult(result);
    },
  };
}

// Tool: Search stored code and egress handlers
function createSearchTool(env: Env): AgentTool {
  return {
    name: "search",
    description:
      "Search stored code and egress handlers. Use this to find reusable code or check which network domains are supported before attempting outbound HTTP.",
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

      const datastore = getDatastore(env);
      const results = await datastore.search(collection, p.query ?? "*", limit);

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

// Format execution result for the agent
function formatExecutionResult(result: ExecutionResult): AgentToolResult<unknown> {
  if (result.ok) {
    const text = result.result !== undefined
      ? `Result: ${JSON.stringify(result.result, null, 2)}`
      : "Code executed successfully.";

    return {
      content: [{ type: "text", text }],
      details: result,
    };
  } else {
    const text = result.error ? `Error: ${result.error}` : "Unknown error during execution.";
    return {
      content: [{ type: "text", text }],
      details: result,
    };
  }
}
