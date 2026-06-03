import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExecutionResult } from "../../../internal-types/tools.js";

export const MAX_TOOL_RESPONSE_LENGTH_CHARS = 1_000_000;
export const DEFAULT_TOOL_RESPONSE_LENGTH_CHARS = 8_000;

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
  }

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
