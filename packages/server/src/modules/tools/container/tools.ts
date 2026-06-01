/**
 * Container Tools - Model-visible tool factories
 * 
 * These tools provide the agent with filesystem and command execution
 * capabilities within an isolated container environment.
 */

import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { Static, TSchema } from "@earendil-works/pi-ai";
import type { Env } from "../../../internal-types/index.js";
import {
  containerBash,
  containerRead,
  containerWrite,
  containerEdit,
  containerGrep,
  containerFind,
  containerLs,
  destroyContainer,
  getContainerHealth,
} from "./client.js";
import { deriveContainerId } from "./ids.js";
import { tailToolOutput, getEffectiveOutputLimit } from "./output.js";

// Tool execution context
export interface ContainerToolContext {
  sessionId: string;
}

// Container create parameters
interface ContainerCreateParams {
  containerId?: string;
  description?: string;
}

// Container bash parameters
interface ContainerBashParams {
  containerId?: string;
  command: string;
  cwd?: string;
  timeoutMs?: number;
  maxOutputChars?: number;
}

// Container read parameters
interface ContainerReadParams {
  containerId?: string;
  path: string;
  startLine?: number;
  endLine?: number;
  maxBytes?: number;
}

// Container write parameters
interface ContainerWriteParams {
  containerId?: string;
  path: string;
  content: string;
  append?: boolean;
  makeDirs?: boolean;
}

// Container edit parameters
interface ContainerEditParams {
  containerId?: string;
  path: string;
  oldString: string;
  newString: string;
  replaceAll?: boolean;
}

// Container grep parameters
interface ContainerGrepParams {
  containerId?: string;
  pattern: string;
  path?: string;
  include?: string;
  maxMatches?: number;
}

// Container find parameters
interface ContainerFindParams {
  containerId?: string;
  path?: string;
  name?: string;
  type?: "file" | "directory" | "any";
  maxResults?: number;
}

// Container ls parameters
interface ContainerLsParams {
  containerId?: string;
  path?: string;
  recursive?: boolean;
  maxResults?: number;
}

interface ContainerDestroyParams {
  containerId?: string;
}

// Format bash result for the agent
function formatBashResult(result: {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
  truncated: boolean;
  killed: boolean;
}, maxOutputChars?: number): { text: string; truncated: boolean; originalLength: number } {
  const parts: string[] = [];
  
  if (result.stdout) {
    parts.push(`Stdout:\n${result.stdout}`);
  }
  if (result.stderr) {
    parts.push(`Stderr:\n${result.stderr}`);
  }
  if (result.exitCode !== null && result.exitCode !== 0) {
    parts.push(`Exit code: ${result.exitCode}`);
  }
  if (result.killed) {
    parts.push("(Process killed due to timeout)");
  }
  
  const text = parts.length > 0 ? parts.join("\n\n") : "Command executed successfully.";
  const limit = getEffectiveOutputLimit(maxOutputChars);
  const output = tailToolOutput(text, limit);
  
  return {
    text: output.text,
    truncated: output.truncated,
    originalLength: output.originalLength,
  };
}

// Format grep results
function formatGrepResult(result: {
  matches: Array<{ path: string; line: number; text: string }>;
  matchCount: number;
  truncated: boolean;
  pattern: string;
}): string {
  if (result.matchCount === 0) {
    return `No matches found for pattern "${result.pattern}".`;
  }
  
  const lines: string[] = [];
  lines.push(`Found ${result.matchCount} match${result.matchCount !== 1 ? "es" : ""} for "${result.pattern}":`);
  lines.push("");
  
  for (const match of result.matches.slice(0, 50)) {
    lines.push(`${match.path}:${match.line}: ${match.text.slice(0, 150)}`);
  }
  
  if (result.matchCount > 50) {
    lines.push("");
    lines.push(`...and ${result.matchCount - 50} more matches. Set maxMatches to see more.`);
  }
  
  if (result.truncated) {
    lines.push("");
    lines.push("(Results truncated due to maxMatches limit)");
  }
  
  return lines.join("\n");
}

// Format find results
function formatFindResult(result: {
  results: Array<{ path: string; type: string; size: number; mtime: string | null }>;
  resultCount: number;
  truncated: boolean;
}): string {
  if (result.resultCount === 0) {
    return "No files found.";
  }
  
  const lines: string[] = [];
  lines.push(`Found ${result.resultCount} result${result.resultCount !== 1 ? "s" : ""}:`);
  lines.push("");
  
  for (const item of result.results.slice(0, 100)) {
    const typeChar = item.type === "directory" ? "d" : "f";
    const sizeStr = item.type === "directory" ? "-" : formatBytes(item.size);
    const mtime = item.mtime ? new Date(item.mtime).toISOString().slice(0, 19) : "-";
    lines.push(`[${typeChar}] ${item.path.padEnd(50)} ${sizeStr.padStart(10)} ${mtime}`);
  }
  
  if (result.resultCount > 100) {
    lines.push("");
    lines.push(`...and ${result.resultCount - 100} more results. Set maxResults to see more.`);
  }
  
  if (result.truncated) {
    lines.push("");
    lines.push("(Results truncated due to maxResults limit)");
  }
  
  return lines.join("\n");
}

// Format ls results
function formatLsResult(result: {
  entries: Array<{ name: string; type: string; size: number; mode: string | null; mtime: string | null }>;
  entryCount: number;
  truncated: boolean;
}): string {
  if (result.entryCount === 0) {
    return "Directory is empty.";
  }
  
  const lines: string[] = [];
  lines.push("Directory contents:");
  lines.push("");
  
  // Group directories first
  const dirs = result.entries.filter((e) => e.type === "directory");
  const files = result.entries.filter((e) => e.type === "file");
  
  for (const dir of dirs) {
    lines.push(`[d] ${dir.name}/`);
  }
  for (const file of files) {
    const sizeStr = formatBytes(file.size);
    lines.push(`[f] ${file.name.padEnd(40)} ${sizeStr}`);
  }
  
  if (result.truncated) {
    lines.push("");
    lines.push("(Results truncated due to maxResults limit)");
  }
  
  return lines.join("\n");
}

// Format bytes to human readable
function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

// Tool: container_create
export function createContainerCreateTool(
  env: Env,
  ctx: ContainerToolContext
): AgentTool {
  return {
    name: "container_create",
    description:
      "Create or initialize a persistent coding container for this session. " +
      "This container provides an isolated environment with bash, git, ripgrep, " +
      "and other development tools. The container persists for the session duration " +
      "and maintains its filesystem state. Container egress is routed through " +
      "Clawflare's security layer.",
    label: "Create Container",
    parameters: Type.Object({
      containerId: Type.Optional(Type.String({
        description: "Optional custom container ID. If not provided, uses session ID.",
      })),
      description: Type.Optional(Type.String({
        description: "Optional description of the container's purpose",
      })),
    }) as TSchema,
    execute: async (
      _toolCallId: string,
      params: Static<TSchema>,
      signal?: AbortSignal
    ): Promise<AgentToolResult<unknown>> => {
      const p = params as ContainerCreateParams;
      const containerId = deriveContainerId(ctx.sessionId, p.containerId);
      
      // Get or start container
      const health = await getContainerHealth(env, containerId, signal);
      
      const lines: string[] = [
        `Container ready: ${containerId}`,
        `Status: ${health.status}`,
        `Workspace: /workspace`,
      ];
      
      if (p.description) {
        lines.push(`Purpose: ${p.description}`);
      }
      
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          containerId,
          status: health.status,
          workspace: health.workspace,
        },
      };
    },
  };
}

// Tool: container_bash
export function createContainerBashTool(
  env: Env,
  ctx: ContainerToolContext
): AgentTool {
  return {
    name: "container_bash",
    description:
      "Execute a shell command in the container's workspace. " +
      "The command runs with bash -lc. Output is tailed when truncated. " +
      "Commands have access to git, ripgrep, curl, and other development tools.",
    label: "Container Bash",
    parameters: Type.Object({
      containerId: Type.Optional(Type.String({
        description: "Container ID. Uses session's default container if not specified.",
      })),
      command: Type.String({
        description: "Shell command to execute",
      }),
      cwd: Type.Optional(Type.String({
        description: "Working directory relative to /workspace (default: .)",
      })),
      timeoutMs: Type.Optional(Type.Number({
        description: "Timeout in milliseconds (default: 1800000, max: 3600000)",
        minimum: 1000,
        maximum: 3600000,  // 60 minutes
      })),
      maxOutputChars: Type.Optional(Type.Number({
        description: "Maximum characters to return (default: 8000)",
        minimum: 1,
        maximum: 1_000_000,
      })),
    }) as TSchema,
    execute: async (
      _toolCallId: string,
      params: Static<TSchema>,
      signal?: AbortSignal
    ): Promise<AgentToolResult<unknown>> => {
      const p = params as ContainerBashParams;
      const containerId = deriveContainerId(ctx.sessionId, p.containerId);
      
      const result = await containerBash(
        env,
        containerId,
        p.command,
        p.cwd,
        p.timeoutMs,
        p.maxOutputChars,
        signal
      );
      
      const formatted = formatBashResult(result, p.maxOutputChars);
      
      return {
        content: [{ type: "text", text: formatted.text }],
        details: {
          ok: result.ok,
          exitCode: result.exitCode,
          durationMs: result.durationMs,
          truncated: formatted.truncated,
          originalLength: formatted.originalLength,
          killed: result.killed,
        },
      };
    },
  };
}

// Tool: container_read
export function createContainerReadTool(
  env: Env,
  ctx: ContainerToolContext
): AgentTool {
  return {
    name: "container_read",
    description:
      "Read a text file from the container workspace. " +
      "Supports optional line ranges (1-indexed). " +
      "Only UTF-8 text files are supported.",
    label: "Container Read",
    parameters: Type.Object({
      containerId: Type.Optional(Type.String({
        description: "Container ID. Uses session's default container if not specified.",
      })),
      path: Type.String({
        description: "File path relative to /workspace",
      }),
      startLine: Type.Optional(Type.Number({
        description: "Start line (1-indexed, inclusive)",
        minimum: 1,
      })),
      endLine: Type.Optional(Type.Number({
        description: "End line (1-indexed, inclusive)",
        minimum: 1,
      })),
      maxBytes: Type.Optional(Type.Number({
        description: "Maximum bytes to read (default: 200000)",
        minimum: 1,
      })),
    }) as TSchema,
    execute: async (
      _toolCallId: string,
      params: Static<TSchema>,
      signal?: AbortSignal
    ): Promise<AgentToolResult<unknown>> => {
      const p = params as ContainerReadParams;
      const containerId = deriveContainerId(ctx.sessionId, p.containerId);
      
      const result = await containerRead(
        env,
        containerId,
        p.path,
        p.startLine,
        p.endLine,
        p.maxBytes,
        signal
      );
      
      const lines: string[] = [];
      lines.push(`--- ${result.path} ---`);
      lines.push(result.content);
      
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          path: result.path,
          totalLines: result.totalLines,
          size: result.size,
        },
      };
    },
  };
}

// Tool: container_write
export function createContainerWriteTool(
  env: Env,
  ctx: ContainerToolContext
): AgentTool {
  return {
    name: "container_write",
    description:
      "Write or append content to a file in the container workspace. " +
      "Creates parent directories automatically by default. " +
      "Use append=true to add to an existing file.",
    label: "Container Write",
    parameters: Type.Object({
      containerId: Type.Optional(Type.String({
        description: "Container ID. Uses session's default container if not specified.",
      })),
      path: Type.String({
        description: "File path relative to /workspace",
      }),
      content: Type.String({
        description: "Content to write (UTF-8)",
      }),
      append: Type.Optional(Type.Boolean({
        description: "Append to file instead of overwriting (default: false)",
      })),
      makeDirs: Type.Optional(Type.Boolean({
        description: "Create parent directories if they don't exist (default: true)",
      })),
    }) as TSchema,
    execute: async (
      _toolCallId: string,
      params: Static<TSchema>,
      signal?: AbortSignal
    ): Promise<AgentToolResult<unknown>> => {
      const p = params as ContainerWriteParams;
      const containerId = deriveContainerId(ctx.sessionId, p.containerId);
      
      const result = await containerWrite(
        env,
        containerId,
        p.path,
        p.content,
        p.append,
        p.makeDirs,
        signal
      );
      
      const action = result.appended ? "Appended to" : "Wrote";
      return {
        content: [{ type: "text", text: `${action} ${result.path} (${result.bytesWritten} bytes, total ${result.totalSize})` }],
        details: result,
      };
    },
  };
}

// Tool: container_edit
export function createContainerEditTool(
  env: Env,
  ctx: ContainerToolContext
): AgentTool {
  return {
    name: "container_edit",
    description:
      "Make surgical edits to a file by replacing an exact string. " +
      "The oldString must match exactly one occurrence unless replaceAll=true. " +
      "This is the preferred way to modify files when making changes.",
    label: "Container Edit",
    parameters: Type.Object({
      containerId: Type.Optional(Type.String({
        description: "Container ID. Uses session's default container if not specified.",
      })),
      path: Type.String({
        description: "File path relative to /workspace",
      }),
      oldString: Type.String({
        description: "Exact string to find and replace",
      }),
      newString: Type.String({
        description: "Replacement string",
      }),
      replaceAll: Type.Optional(Type.Boolean({
        description: "Replace all occurrences (default: false)",
      })),
    }) as TSchema,
    execute: async (
      _toolCallId: string,
      params: Static<TSchema>,
      signal?: AbortSignal
    ): Promise<AgentToolResult<unknown>> => {
      const p = params as ContainerEditParams;
      const containerId = deriveContainerId(ctx.sessionId, p.containerId);
      
      const result = await containerEdit(
        env,
        containerId,
        p.path,
        p.oldString,
        p.newString,
        p.replaceAll,
        signal
      );
      
      const lines: string[] = [
        `Edited ${result.path}:`,
        `  ${result.replacements} replacement${result.replacements !== 1 ? "s" : ""} made`,
      ];
      
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: result,
      };
    },
  };
}

// Tool: container_grep
export function createContainerGrepTool(
  env: Env,
  ctx: ContainerToolContext
): AgentTool {
  return {
    name: "container_grep",
    description:
      "Search file contents for a pattern using ripgrep (or grep as fallback). " +
      "Returns file path, line number, and matched text for each match.",
    label: "Container Grep",
    parameters: Type.Object({
      containerId: Type.Optional(Type.String({
        description: "Container ID. Uses session's default container if not specified.",
      })),
      pattern: Type.String({
        description: "Pattern to search for",
      }),
      path: Type.Optional(Type.String({
        description: "Path to search (file or directory, default: .)",
      })),
      include: Type.Optional(Type.String({
        description: "Include pattern for files (e.g., '*.ts')",
      })),
      maxMatches: Type.Optional(Type.Number({
        description: "Maximum matches to return (default: 100)",
        minimum: 1,
        maximum: 1000,
      })),
    }) as TSchema,
    execute: async (
      _toolCallId: string,
      params: Static<TSchema>,
      signal?: AbortSignal
    ): Promise<AgentToolResult<unknown>> => {
      const p = params as ContainerGrepParams;
      const containerId = deriveContainerId(ctx.sessionId, p.containerId);
      
      const result = await containerGrep(
        env,
        containerId,
        p.pattern,
        p.path,
        p.include,
        p.maxMatches,
        signal
      );
      
      return {
        content: [{ type: "text", text: formatGrepResult(result) }],
        details: result,
      };
    },
  };
}

// Tool: container_find
export function createContainerFindTool(
  env: Env,
  ctx: ContainerToolContext
): AgentTool {
  return {
    name: "container_find",
    description:
      "Find files or directories by name pattern. " +
      "Returns file type, size, and modification time.",
    label: "Container Find",
    parameters: Type.Object({
      containerId: Type.Optional(Type.String({
        description: "Container ID. Uses session's default container if not specified.",
      })),
      path: Type.Optional(Type.String({
        description: "Starting path (default: .)",
      })),
      name: Type.Optional(Type.String({
        description: "Name pattern with * and ? wildcards (e.g., '*.ts')",
      })),
      type: Type.Optional(Type.Union([
        Type.Literal("file", { description: "Files only" }),
        Type.Literal("directory", { description: "Directories only" }),
        Type.Literal("any", { description: "Files and directories" }),
      ], { description: "Type filter (default: any)" })),
      maxResults: Type.Optional(Type.Number({
        description: "Maximum results to return (default: 200)",
        minimum: 1,
        maximum: 1000,
      })),
    }) as TSchema,
    execute: async (
      _toolCallId: string,
      params: Static<TSchema>,
      signal?: AbortSignal
    ): Promise<AgentToolResult<unknown>> => {
      const p = params as ContainerFindParams;
      const containerId = deriveContainerId(ctx.sessionId, p.containerId);
      
      const result = await containerFind(
        env,
        containerId,
        p.path,
        p.name,
        p.type,
        p.maxResults,
        signal
      );
      
      return {
        content: [{ type: "text", text: formatFindResult(result) }],
        details: result,
      };
    },
  };
}

// Tool: container_ls
export function createContainerLsTool(
  env: Env,
  ctx: ContainerToolContext
): AgentTool {
  return {
    name: "container_ls",
    description:
      "List directory contents in the container. " +
      "Shows file/directory name, type, size, and modification time.",
    label: "Container List",
    parameters: Type.Object({
      containerId: Type.Optional(Type.String({
        description: "Container ID. Uses session's default container if not specified.",
      })),
      path: Type.Optional(Type.String({
        description: "Directory path (default: .)",
      })),
      recursive: Type.Optional(Type.Boolean({
        description: "List recursively (default: false)",
      })),
      maxResults: Type.Optional(Type.Number({
        description: "Maximum entries to return (default: 200)",
        minimum: 1,
        maximum: 1000,
      })),
    }) as TSchema,
    execute: async (
      _toolCallId: string,
      params: Static<TSchema>,
      signal?: AbortSignal
    ): Promise<AgentToolResult<unknown>> => {
      const p = params as ContainerLsParams;
      const containerId = deriveContainerId(ctx.sessionId, p.containerId);
      
      const result = await containerLs(
        env,
        containerId,
        p.path,
        p.recursive,
        p.maxResults,
        signal
      );
      
      return {
        content: [{ type: "text", text: formatLsResult(result) }],
        details: result,
      };
    },
  };
}

// Tool: container_destroy
export function createContainerDestroyTool(
  env: Env,
  ctx: ContainerToolContext
): AgentTool {
  return {
    name: "container_destroy",
    description:
      "Destroy a session container when it is no longer needed. " +
      "This releases the container instance and its ephemeral runtime state.",
    label: "Destroy Container",
    parameters: Type.Object({
      containerId: Type.Optional(Type.String({
        description: "Container ID. Uses session's default container if not specified.",
      })),
    }) as TSchema,
    execute: async (
      _toolCallId: string,
      params: Static<TSchema>,
      signal?: AbortSignal
    ): Promise<AgentToolResult<unknown>> => {
      const p = params as ContainerDestroyParams;
      const containerId = deriveContainerId(ctx.sessionId, p.containerId);
      if (signal?.aborted) {
        throw new Error("Container destroy aborted");
      }
      await destroyContainer(env, containerId);

      return {
        content: [{ type: "text", text: `Destroyed container: ${containerId}` }],
        details: { ok: true, containerId },
      };
    },
  };
}

// Export all container tools factory
export function createContainerTools(
  env: Env,
  ctx: ContainerToolContext
): AgentTool[] {
  return [
    createContainerCreateTool(env, ctx),
    createContainerBashTool(env, ctx),
    createContainerReadTool(env, ctx),
    createContainerWriteTool(env, ctx),
    createContainerEditTool(env, ctx),
    createContainerGrepTool(env, ctx),
    createContainerFindTool(env, ctx),
    createContainerLsTool(env, ctx),
    createContainerDestroyTool(env, ctx),
  ];
}
