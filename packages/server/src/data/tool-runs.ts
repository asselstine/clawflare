import { and, eq } from "drizzle-orm";
import { createDb, type Db } from "./db.js";
import { toolRuns } from "./schema.js";
import { SessionRunRepository } from "./session-runs.js";

export type ToolRunStatus = "running" | "complete" | "error" | "aborted";

export interface ToolRun {
  id: string;
  sessionId: string;
  workspaceId?: string;
  toolCallId: string;
  toolName: string;
  status: ToolRunStatus;
  input: unknown;
  internalState?: unknown;
  partialResult?: unknown;
  result?: unknown;
  errorMessage?: string;
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
}

export interface MarkToolRunRunningParams {
  sessionId: string;
  workspaceId?: string;
  toolCallId: string;
  toolName: string;
  input: unknown;
  internalState?: unknown;
  partialResult?: unknown;
}

export interface MarkToolRunTerminalParams extends MarkToolRunRunningParams {
  status: Exclude<ToolRunStatus, "running">;
  result: unknown;
  errorMessage?: string;
}

function resolveDb(db: Db | D1Database): Db {
  return "query" in db ? db : createDb(db);
}

function toolRunId(sessionId: string, toolCallId: string): string {
  return `toolrun_${sessionId}_${toolCallId}`;
}

function stringifyOptional(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function parseOptional(value: string | null): unknown | undefined {
  return value === null ? undefined : JSON.parse(value);
}

function extractErrorMessage(result: unknown): string | undefined {
  if (typeof result !== "object" || result === null || !("content" in result)) return undefined;
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  return content
    .filter((part): part is { type: string; text?: string } =>
      typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text"
    )
    .map((part) => part.text ?? "")
    .join("") || undefined;
}

function mapToolRun(row: typeof toolRuns.$inferSelect): ToolRun {
  return {
    id: row.id,
    sessionId: row.sessionId,
    workspaceId: row.workspaceId ?? undefined,
    toolCallId: row.toolCallId,
    toolName: row.toolName,
    status: row.status as ToolRunStatus,
    input: JSON.parse(row.inputJson),
    internalState: parseOptional(row.internalStateJson),
    partialResult: parseOptional(row.partialResultJson),
    result: parseOptional(row.resultJson),
    errorMessage: row.errorMessage ?? undefined,
    startedAt: row.startedAt,
    updatedAt: row.updatedAt,
    completedAt: row.completedAt ?? undefined,
  };
}

export class ToolRunRepository {
  private readonly db: Db;

  constructor(db: Db | D1Database) {
    this.db = resolveDb(db);
  }

  async findByToolCall(sessionId: string, toolCallId: string): Promise<ToolRun | null> {
    const row = await this.db.query.toolRuns.findFirst({
      where: and(eq(toolRuns.sessionId, sessionId), eq(toolRuns.toolCallId, toolCallId)),
    });
    return row ? mapToolRun(row) : null;
  }

  async markRunning(params: MarkToolRunRunningParams): Promise<ToolRun> {
    const now = Date.now();
    const id = toolRunId(params.sessionId, params.toolCallId);
    const values = {
      id,
      sessionId: params.sessionId,
      workspaceId: params.workspaceId,
      toolCallId: params.toolCallId,
      toolName: params.toolName,
      status: "running" as const,
      inputJson: JSON.stringify(params.input),
      internalStateJson: stringifyOptional(params.internalState),
      partialResultJson: stringifyOptional(params.partialResult),
      resultJson: null,
      errorMessage: null,
      startedAt: now,
      updatedAt: now,
      completedAt: null,
    };

    await this.db
      .insert(toolRuns)
      .values(values)
      .onConflictDoUpdate({
        target: toolRuns.id,
        set: {
          toolName: values.toolName,
          status: values.status,
          inputJson: values.inputJson,
          internalStateJson: values.internalStateJson,
          partialResultJson: values.partialResultJson,
          resultJson: values.resultJson,
          errorMessage: values.errorMessage,
          updatedAt: values.updatedAt,
          completedAt: values.completedAt,
        },
      });

    return (await this.findByToolCall(params.sessionId, params.toolCallId))!;
  }

  async markTerminal(params: MarkToolRunTerminalParams): Promise<ToolRun> {
    const now = Date.now();
    const id = toolRunId(params.sessionId, params.toolCallId);
    const values = {
      id,
      sessionId: params.sessionId,
      workspaceId: params.workspaceId,
      toolCallId: params.toolCallId,
      toolName: params.toolName,
      status: params.status,
      inputJson: JSON.stringify(params.input),
      internalStateJson: stringifyOptional(params.internalState),
      partialResultJson: stringifyOptional(params.partialResult),
      resultJson: JSON.stringify(params.result),
      errorMessage: params.errorMessage ?? extractErrorMessage(params.result) ?? null,
      startedAt: now,
      updatedAt: now,
      completedAt: now,
    };

    await this.db
      .insert(toolRuns)
      .values(values)
      .onConflictDoUpdate({
        target: toolRuns.id,
        set: {
          toolName: values.toolName,
          status: values.status,
          inputJson: values.inputJson,
          internalStateJson: values.internalStateJson,
          partialResultJson: values.partialResultJson,
          resultJson: values.resultJson,
          errorMessage: values.errorMessage,
          updatedAt: values.updatedAt,
          completedAt: values.completedAt,
        },
      });

    await this.wakeRunnableSessionRuns(params.sessionId);

    return (await this.findByToolCall(params.sessionId, params.toolCallId))!;
  }

  private async wakeRunnableSessionRuns(sessionId: string): Promise<void> {
    await new SessionRunRepository(this.db).wakeRunnableForSession(sessionId);
  }
}
