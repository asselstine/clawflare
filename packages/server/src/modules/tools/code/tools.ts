import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { Static, TSchema } from "@earendil-works/pi-ai";
import { StoredCodeRepository } from "../../../data/index.js";
import { USER_FUNCTION_CONTRACT, executeDynamicWorker } from "./dynamic-worker.js";
import { formatExecutionResult, MAX_TOOL_RESPONSE_LENGTH_CHARS } from "./output.js";
import {
  requireBuiltinToolContext,
  type RuntimeTool,
  type ToolModule,
  type ToolRuntimeContext,
} from "../types.js";

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
  timeoutMs?: number;
}

interface ExecuteCodeParams {
  code: string;
  description?: string;
  input?: unknown;
  maxResponseLength?: number;
  timeoutMs?: number;
}

const VALID_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

function validateName(name: string): void {
  if (!VALID_NAME_PATTERN.test(name)) {
    throw new Error(
      `Invalid name "${name}". Names must match pattern: ${VALID_NAME_PATTERN.source}`
    );
  }
}

export const storeCodeTool: RuntimeTool = {
  ref: "code.store_code",
  groupId: "code",
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
    context: ToolRuntimeContext,
    _toolCallId: string,
    params: Static<TSchema>,
    _signal?: AbortSignal
  ): Promise<AgentToolResult<unknown>> => {
    const runtime = requireBuiltinToolContext(context);
    const p = params as StoreCodeParams;

    validateName(p.name);

    const storedCode = new StoredCodeRepository(runtime.env.DB);
    await storedCode.upsert({
      workspaceId: runtime.workspaceId,
      name: p.name,
      description: p.description || "",
      code: p.code,
    });

    return {
      content: [{ type: "text", text: `Stored code "${p.name}".` }],
      details: { name: p.name, description: p.description, workspaceId: runtime.workspaceId },
    };
  },
};

export const executeStoredCodeTool: RuntimeTool = {
  ref: "code.execute_stored_code",
  groupId: "code",
  name: "execute_stored_code",
  description:
    `Execute previously stored JavaScript code by name. The code runs in an isolated Dynamic Worker. Stored code must follow this contract: ${USER_FUNCTION_CONTRACT}`,
  label: "Execute Stored Code",
  parameters: Type.Object({
    name: Type.String({ description: "Name of the stored code to execute" }),
    description: Type.Optional(Type.String({ description: "Brief description of this execution (80 chars max)" })),
    input: Type.Optional(Type.Unknown({ description: "Input data to pass to the code" })),
    timeoutMs: Type.Optional(Type.Number({
      description: "Execution timeout in milliseconds (default: 60000, max: 300000). Use short values for API calls.",
      minimum: 1000,
      maximum: 300000,
    })),
    maxResponseLength: Type.Optional(Type.Number({
      description: "Maximum response characters to return to the agent. Output is tailed when truncated. Hard cap: 1,000,000.",
      minimum: 1,
      maximum: MAX_TOOL_RESPONSE_LENGTH_CHARS,
    })),
  }) as TSchema,
  execute: async (
    context: ToolRuntimeContext,
    toolCallId: string,
    params: Static<TSchema>,
    signal?: AbortSignal
  ): Promise<AgentToolResult<unknown>> => {
    const runtime = requireBuiltinToolContext(context);
    const p = params as ExecuteStoredCodeParams;

    validateName(p.name);

    const storedCode = new StoredCodeRepository(runtime.env.DB);
    const stored = await storedCode.get(runtime.workspaceId, p.name);

    if (!stored) {
      throw new Error(`Code "${p.name}" not found in workspace. Use store_code to save it first.`);
    }

    const result = await executeDynamicWorker(runtime.env, runtime.executionCtx, stored.code, p.input, {
      requestId: `session:${runtime.sessionId}`,
      sessionId: runtime.sessionId,
      workspaceId: runtime.workspaceId,
      executionId: toolCallId,
      signal,
      timeoutMs: p.timeoutMs,
    });

    return formatExecutionResult(result, {
      maxResponseLength: p.maxResponseLength,
      executedCode: stored.code,
    });
  },
};

export const executeCodeTool: RuntimeTool = {
  ref: "code.execute_code",
  groupId: "code",
  name: "execute_code",
  description:
    `Execute JavaScript code in an isolated Dynamic Worker. Code must follow this contract: ${USER_FUNCTION_CONTRACT}`,
  label: "Execute Code",
  parameters: Type.Object({
    code: Type.String({ description: `JavaScript ES module to execute. ${USER_FUNCTION_CONTRACT}` }),
    description: Type.Optional(Type.String({ description: "Brief description of what the code does (80 chars max)" })),
    input: Type.Optional(Type.Unknown({ description: "Input data to pass to the code" })),
    timeoutMs: Type.Optional(Type.Number({
      description: "Execution timeout in milliseconds (default: 60000, max: 300000). Use short values for API calls.",
      minimum: 1000,
      maximum: 300000,
    })),
    maxResponseLength: Type.Optional(Type.Number({
      description: "Maximum response characters to return to the agent. Output is tailed when truncated. Hard cap: 1,000,000.",
      minimum: 1,
      maximum: MAX_TOOL_RESPONSE_LENGTH_CHARS,
    })),
  }) as TSchema,
  execute: async (
    context: ToolRuntimeContext,
    toolCallId: string,
    params: Static<TSchema>,
    signal?: AbortSignal
  ): Promise<AgentToolResult<unknown>> => {
    const runtime = requireBuiltinToolContext(context);
    const p = params as ExecuteCodeParams;

    const result = await executeDynamicWorker(runtime.env, runtime.executionCtx, p.code, p.input, {
      requestId: `session:${runtime.sessionId}`,
      sessionId: runtime.sessionId,
      workspaceId: runtime.workspaceId,
      executionId: toolCallId,
      signal,
      timeoutMs: p.timeoutMs,
    });

    return formatExecutionResult(result, { maxResponseLength: p.maxResponseLength });
  },
};

export const codeToolModule: ToolModule = {
  id: "code",
  label: "Code",
  tools: [
    storeCodeTool,
    executeStoredCodeTool,
    executeCodeTool,
  ],
};
