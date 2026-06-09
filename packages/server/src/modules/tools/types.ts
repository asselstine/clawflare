import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import type { Static, TSchema } from "@earendil-works/pi-ai";
import type { Env } from "../../internal-types/index.js";

export interface ToolContext {
  sessionId?: string;
  workspaceId?: string;
}

export interface BuiltinToolRuntimeContext {
  kind: "builtin";
  env: Env;
  executionCtx?: ExecutionContext;
  sessionId: string;
  workspaceId: string;
}

export interface CustomToolRuntimeContext {
  kind: "custom";
  sessionId: string;
  workspaceId: string;
  services: Record<string, unknown>;
}

export type ToolRuntimeContext = BuiltinToolRuntimeContext | CustomToolRuntimeContext;

export interface ToolGroup {
  id: string;
  label: string;
}

export interface RuntimeTool<TParameters extends TSchema = TSchema> extends Omit<AgentTool<TParameters>, "execute"> {
  groupId: string;
  ref: string;
  execute: (
    context: ToolRuntimeContext,
    toolCallId: string,
    params: Static<TParameters>,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback,
    toolRunState?: unknown,
  ) => Promise<AgentToolResult<unknown>>;
}

export interface ToolModule extends ToolGroup {
  tools: RuntimeTool[];
}

export function requireBuiltinToolContext(context: ToolRuntimeContext): BuiltinToolRuntimeContext {
  if (context.kind !== "builtin") {
    throw new Error("Tool requires built-in runtime context");
  }
  return context;
}
