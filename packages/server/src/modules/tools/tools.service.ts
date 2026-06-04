// Tool registry orchestration for the Clawflare Agent.

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Env } from "../../internal-types/index.js";
import { SessionToolRepository } from "../../data/index.js";
import { codeToolModule } from "./code/tools.js";
import { containerToolModule } from "./container/tools.js";
import { searchToolModule } from "./search/tools.js";
import type { BuiltinToolRuntimeContext, RuntimeTool, ToolContext, ToolGroup, ToolModule } from "./types.js";
export type { RuntimeTool, ToolContext, ToolRuntimeContext } from "./types.js";

const builtinToolModules: ToolModule[] = [
  codeToolModule,
  searchToolModule,
  containerToolModule,
];

const builtinToolRegistry = builtinToolModules.flatMap((toolModule) => toolModule.tools);
const builtinToolsByRef = new Map(builtinToolRegistry.map((tool) => [tool.ref, tool]));

export function listBuiltinTools(): RuntimeTool[] {
  return builtinToolRegistry;
}

export function defaultSessionToolRefs(): string[] {
  return builtinToolRegistry.map((tool) => tool.ref);
}

function resolveBuiltinToolRef(ref: string): RuntimeTool | undefined {
  return builtinToolsByRef.get(ref);
}

export function loadBuiltinToolsByRefs(toolRefs: string[]): RuntimeTool[] {
  return toolRefs.flatMap((toolRef) => {
    const tool = resolveBuiltinToolRef(toolRef);
    return tool ? [tool] : [];
  });
}

export async function loadSessionBuiltinToolRefs(env: Env, sessionId?: string): Promise<string[]> {
  if (!sessionId) {
    throw new Error("Tool loading requires a session");
  }

  const sessionTools = new SessionToolRepository(env.DB);
  const records = await sessionTools.list(sessionId, { enabledOnly: true });
  return records
    .filter((record) => record.toolRefType === "builtin")
    .map((record) => record.toolRef);
}

export async function loadSessionTools(env: Env, sessionId?: string): Promise<RuntimeTool[]> {
  return loadBuiltinToolsByRefs(await loadSessionBuiltinToolRefs(env, sessionId));
}

export function listToolGroups(): ToolGroup[] {
  return builtinToolModules.map(({ id, label }) => ({ id, label }));
}

export async function seedDefaultSessionTools(env: Env, sessionId: string): Promise<void> {
  const sessionTools = new SessionToolRepository(env.DB);
  await sessionTools.seedDefaults(sessionId, defaultSessionToolRefs());
}

export function createBuiltinToolRuntimeContext(args: {
  env: Env;
  ctx?: ExecutionContext;
  toolCtx?: ToolContext;
}): BuiltinToolRuntimeContext {
  if (!args.toolCtx?.sessionId) {
    throw new Error("Tool execution requires a session");
  }
  if (!args.toolCtx.workspaceId) {
    throw new Error("Tool execution requires a workspace");
  }

  return {
    kind: "builtin",
    env: args.env,
    executionCtx: args.ctx,
    sessionId: args.toolCtx.sessionId,
    workspaceId: args.toolCtx.workspaceId,
  };
}

export async function invokeTool(args: {
  env: Env;
  ctx?: ExecutionContext;
  toolCtx?: ToolContext;
  name: string;
  input?: unknown;
  signal?: AbortSignal;
}): Promise<AgentToolResult<unknown>> {
  const tools = await loadSessionTools(args.env, args.toolCtx?.sessionId);
  const tool = tools.find((candidate) => candidate.name === args.name);
  if (!tool) {
    throw new Error(`Tool not found: ${args.name}`);
  }

  return tool.execute(
    createBuiltinToolRuntimeContext({ env: args.env, ctx: args.ctx, toolCtx: args.toolCtx }),
    crypto.randomUUID(),
    args.input as never,
    args.signal
  );
}
