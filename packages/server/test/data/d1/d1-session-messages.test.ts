import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import {
  applySessionEventProjection,
  SessionEventRepository,
  SessionMessageRepository,
  SessionRepository,
} from "../../../src/data/index.js";
import { projectAndAppendAgentEvents } from "../../../src/runtime/message-projection.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "../../../migrations");
const DEFAULT_WORKSPACE_ID = "test-workspace";

function migrationStatements(migrationFile: string): string[] {
  let content = readFileSync(join(MIGRATIONS_DIR, migrationFile), "utf-8");
  content = content.replace(/^PRAGMA\s+foreign_keys\s*=\s*ON;$/gim, "");
  content = content.replace(/--[^\n]*/g, "");
  return content
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean)
    .map((statement) => statement.replace(/\s+/g, " "));
}

function allMigrationStatements(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .flatMap((file) => migrationStatements(file));
}

async function createDb(): Promise<{ db: D1Database; dispose: () => Promise<void> }> {
  const mf = new Miniflare({
    script: "export default { fetch() { return new Response('ok'); } }",
    modules: true,
    d1Databases: ["DB"],
  });
  const db = await mf.getD1Database("DB");
  for (const statement of allMigrationStatements()) {
    await db.exec(`${statement};`);
  }
  return { db, dispose: () => mf.dispose() };
}

async function createSession(db: D1Database, sessionId = "session-1"): Promise<void> {
  await new SessionRepository(db).save({
    id: sessionId,
    workspaceId: DEFAULT_WORKSPACE_ID,
    workflowId: "workflow-1",
    status: "idle",
    nextEventCursor: "0",
    updatedAt: Date.now(),
    maxQueueSize: 100,
  });
}

describe("D1 Session Message Projection", () => {
  it("replays canonical events into the exact durable message state", async () => {
    const { db, dispose } = await createDb();
    try {
      await createSession(db);
      const events = new SessionEventRepository(db);
      const messages = new SessionMessageRepository(db);

      const userMessage = {
        role: "user",
        content: [{ type: "text", text: "run both checks" }],
        timestamp: 1,
      };
      const assistantMessage = {
        id: "assistant-1",
        role: "assistant",
        content: [
          { type: "text", text: "I'll run both checks." },
          { type: "toolCall", id: "call-1", name: "container_bash", arguments: { command: "pnpm typecheck" } },
          { type: "toolCall", id: "call-2", name: "container_bash", arguments: { command: "pnpm test" } },
        ],
        timestamp: 2,
      };

      await projectAndAppendAgentEvents(events, messages, "session-1", [
        { type: "message_start", message: userMessage },
        { type: "message_end", message: userMessage },
        { type: "message_start", message: { ...assistantMessage, content: [{ type: "text", text: "" }] } },
        { type: "message_update", message: assistantMessage },
        { type: "message_end", message: assistantMessage },
        { type: "tool_execution_start", toolCallId: "call-1", toolName: "container_bash", args: { command: "pnpm typecheck" } },
        { type: "tool_execution_start", toolCallId: "call-2", toolName: "container_bash", args: { command: "pnpm test" } },
        {
          type: "tool_execution_end",
          toolCallId: "call-2",
          toolName: "container_bash",
          result: { content: [{ type: "text", text: "tests ok" }], details: { ok: true } },
          isError: false,
        },
        {
          type: "tool_execution_end",
          toolCallId: "call-1",
          toolName: "container_bash",
          result: { content: [{ type: "text", text: "types ok" }], details: { ok: true } },
          isError: false,
        },
      ] as AgentEvent[], { workspaceId: DEFAULT_WORKSPACE_ID });

      const storedEvents = await events.listSince("session-1", "0", 100);
      const storedMessages = await messages.list("session-1", { limit: 100 });
      const replayed = applySessionEventProjection(storedEvents.events);

      expect(replayed).toEqual(storedMessages.messages);

      const assistant = storedMessages.messages.find((message) => message.role === "assistant");
      expect(assistant?.content).toEqual([
        { type: "text", text: "I'll run both checks." },
        {
          type: "tool_call",
          id: "call-1",
          name: "container_bash",
          input: { command: "pnpm typecheck" },
          status: "complete",
          result: expect.objectContaining({ text: "types ok", isError: false }),
        },
        {
          type: "tool_call",
          id: "call-2",
          name: "container_bash",
          input: { command: "pnpm test" },
          status: "complete",
          result: expect.objectContaining({ text: "tests ok", isError: false }),
        },
      ]);
    } finally {
      await dispose();
    }
  });
});
