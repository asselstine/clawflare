// Internal tool types - tool definitions and execution results

import type { ToolDefinition } from "../types.js";

/**
 * Internal tool with implementation
 */
export interface InternalTool extends ToolDefinition {
  handler: (args: unknown, env: import("./env.js").Env) => Promise<unknown>;
}

/**
 * Dynamic Worker execution result
 */
export interface ExecutionResult {
  ok: boolean;
  result?: unknown;
  error?: string;
  stdout?: string;
  stderr?: string;
}

/**
 * Search parameters for code search
 */
export interface SearchParams {
  query?: string;
  name?: string;
  limit?: number;
}

/**
 * Store code parameters
 */
export interface StoreCodeParams {
  name: string;
  code: string;
  description?: string;
  tags?: string[];
}

/**
 * Execute stored code parameters
 */
export interface ExecuteStoredCodeParams {
  name: string;
  args?: Record<string, unknown>;
}

/**
 * Execute code parameters
 */
export interface ExecuteCodeParams {
  code: string;
  args?: Record<string, unknown>;
}

/**
 * Stored code entry
 */
export interface StoredCodeEntry {
  name: string;
  code: string;
  description?: string;
  tags?: string[];
  createdAt: number;
  updatedAt: number;
}

/**
 * Datastore interface for client operations
 */
export interface Datastore {
  upsertStoredCode(entry: { name: string; code: string; description?: string; tags?: string[] }): Promise<void>;
  getStoredCode(name: string): Promise<{ name: string; code: string; description?: string; tags?: string[]; createdAt: number; updatedAt: number } | null>;
  listEgressHandlers(enabledOnly: boolean): Promise<{ name: string; description: string; domains: string[]; enabled: boolean; config: unknown }[]>;
  search(
    collection: string,
    query: string,
    limit: number
  ): Promise<{
    storedCode: { name: string; code: string; description?: string; tags?: string[]; createdAt: number; updatedAt: number }[];
    egressHandlers: { name: string; description: string; domains: string[]; enabled: boolean; config: unknown }[];
  }>;
}

/**
 * Egress handler metadata for storage
 */
export interface EgressHandlerMetadata {
  name: string;
  description: string;
  domains: string[];
  priority: number;
}
