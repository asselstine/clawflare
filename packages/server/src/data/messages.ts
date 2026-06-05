import { and, asc, desc, eq, gt, lt, max } from "drizzle-orm";
import type {
  Message,
  MessageContentBlock,
  MessageRole,
  MessageStatus,
  SessionEvent,
} from "../types.js";
import { createDb, type Db } from "./db.js";
import { sessionMessages } from "./schema.js";

export interface MessageListOptions {
  after?: string;
  before?: string;
  limit?: number;
}

function resolveDb(db: Db | D1Database): Db {
  return "query" in db ? db : createDb(db);
}

function mapMessage(row: typeof sessionMessages.$inferSelect): Message {
  return {
    id: row.id,
    sessionId: row.sessionId,
    sequence: row.sequence,
    role: row.role as MessageRole,
    status: row.status as MessageStatus,
    content: JSON.parse(row.contentJson) as MessageContentBlock[],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class SessionMessageRepository {
  private readonly db: Db;
  private readonly d1: D1Database;

  constructor(db: Db | D1Database) {
    this.db = resolveDb(db);
    this.d1 = this.db.$client;
  }

  async latestCursor(sessionId: string): Promise<string> {
    const rows = await this.db
      .select({ cursor: max(sessionMessages.sequence) })
      .from(sessionMessages)
      .where(eq(sessionMessages.sessionId, sessionId));

    return String(rows[0]?.cursor ?? 0);
  }

  async list(sessionId: string, options: MessageListOptions = {}): Promise<{ messages: Message[]; nextCursor: string }> {
    const limit = Math.min(options.limit ?? 100, 100);
    const after = Number.parseInt(options.after ?? "", 10) || 0;
    const before = Number.parseInt(options.before ?? "", 10) || 0;

    const rows = await this.db.query.sessionMessages.findMany({
      where: before > 0
        ? and(eq(sessionMessages.sessionId, sessionId), lt(sessionMessages.sequence, before))
        : and(eq(sessionMessages.sessionId, sessionId), gt(sessionMessages.sequence, after)),
      orderBy: before > 0 ? [desc(sessionMessages.sequence)] : [asc(sessionMessages.sequence)],
      limit,
    });

    const messages = rows
      .map(mapMessage)
      .sort((a, b) => a.sequence - b.sequence);

    return {
      messages,
      nextCursor: messages.length > 0 ? String(messages[messages.length - 1]!.sequence) : String(after),
    };
  }

  async listRecent(sessionId: string, limit = 100): Promise<Message[]> {
    const rows = await this.db.query.sessionMessages.findMany({
      where: eq(sessionMessages.sessionId, sessionId),
      orderBy: [desc(sessionMessages.sequence)],
      limit: Math.min(limit, 100),
    });

    return rows.map(mapMessage).sort((a, b) => a.sequence - b.sequence);
  }

  async findById(sessionId: string, messageId: string): Promise<Message | null> {
    const row = await this.db.query.sessionMessages.findFirst({
      where: and(eq(sessionMessages.sessionId, sessionId), eq(sessionMessages.id, messageId)),
    });

    return row ? mapMessage(row) : null;
  }

  async findLatestStreamingAssistant(sessionId: string): Promise<Message | null> {
    const row = await this.db.query.sessionMessages.findFirst({
      where: and(
        eq(sessionMessages.sessionId, sessionId),
        eq(sessionMessages.role, "assistant"),
        eq(sessionMessages.status, "streaming"),
      ),
      orderBy: [desc(sessionMessages.sequence)],
    });

    return row ? mapMessage(row) : null;
  }

  async findLatestAssistantWithToolCall(sessionId: string, toolCallId: string): Promise<Message | null> {
    const rows = await this.db.query.sessionMessages.findMany({
      where: and(eq(sessionMessages.sessionId, sessionId), eq(sessionMessages.role, "assistant")),
      orderBy: [desc(sessionMessages.sequence)],
      limit: 100,
    });

    for (const row of rows) {
      const message = mapMessage(row);
      if (message.content.some((block: MessageContentBlock) => block.type === "tool_call" && block.id === toolCallId)) {
        return message;
      }
    }

    return null;
  }

  async create(input: Omit<Message, "sequence"> & { sequence?: number; workspaceId?: string }): Promise<Message> {
    const now = Date.now();
    const sequence = input.sequence ?? await this.reserveSequence(input.sessionId, now);
    const message: Message = {
      id: input.id,
      sessionId: input.sessionId,
      sequence,
      role: input.role,
      status: input.status,
      content: input.content,
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
    };

    await this.db
      .insert(sessionMessages)
      .values({
        sessionId: message.sessionId,
        sequence: message.sequence,
        workspaceId: input.workspaceId ?? null,
        id: message.id,
        role: message.role,
        status: message.status,
        contentJson: JSON.stringify(message.content),
        createdAt: message.createdAt,
        updatedAt: message.updatedAt,
      })
      .onConflictDoUpdate({
        target: [sessionMessages.sessionId, sessionMessages.id],
        set: {
          status: message.status,
          contentJson: JSON.stringify(message.content),
          updatedAt: message.updatedAt,
        },
      });

    return message;
  }

  async update(message: Message): Promise<Message> {
    await this.db
      .update(sessionMessages)
      .set({
        status: message.status,
        contentJson: JSON.stringify(message.content),
        updatedAt: message.updatedAt,
      })
      .where(and(eq(sessionMessages.sessionId, message.sessionId), eq(sessionMessages.id, message.id)));

    return message;
  }

  async replaceAll(sessionId: string, messages: Message[], workspaceId?: string): Promise<void> {
    await this.db.delete(sessionMessages).where(eq(sessionMessages.sessionId, sessionId));
    if (messages.length === 0) return;

    await this.db.insert(sessionMessages).values(messages.map((message) => ({
      sessionId: message.sessionId,
      sequence: message.sequence,
      workspaceId: workspaceId ?? null,
      id: message.id,
      role: message.role,
      status: message.status,
      contentJson: JSON.stringify(message.content),
      createdAt: message.createdAt,
      updatedAt: message.updatedAt,
    })));
  }

  private async reserveSequence(sessionId: string, now: number): Promise<number> {
    const row = await this.d1
      .prepare(
        `
        INSERT INTO session_counters (
          session_id, next_queue_sequence, next_event_sequence, next_message_sequence, updated_at
        )
        VALUES (?, 1, 1, 2, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          next_message_sequence = next_message_sequence + 1,
          updated_at = excluded.updated_at
        RETURNING next_message_sequence - 1 AS sequence
      `
      )
      .bind(sessionId, now)
      .first<{ sequence: number }>();

    return row?.sequence ?? 1;
  }
}

export function applySessionEventProjection(events: SessionEvent[]): Message[] {
  const messages: Message[] = [];
  const byId = new Map<string, number>();

  for (const event of events) {
    if (event.type === "message.created") {
      byId.set(event.message.id, messages.length);
      messages.push({ ...event.message, content: cloneContent(event.message.content) });
      continue;
    }

    if (event.type === "message.updated" || event.type === "message.completed") {
      const index = byId.get(event.message.id);
      if (index === undefined) {
        byId.set(event.message.id, messages.length);
        messages.push({ ...event.message, content: cloneContent(event.message.content) });
      } else {
        messages[index] = { ...event.message, content: cloneContent(event.message.content) };
      }
      continue;
    }

    if (event.type === "message.errored") {
      const index = byId.get(event.messageId);
      if (index !== undefined) {
        messages[index] = {
          ...messages[index]!,
          status: "error",
          updatedAt: event.timestamp,
        };
      }
    }
  }

  return messages.sort((a, b) => a.sequence - b.sequence);
}

function cloneContent(content: MessageContentBlock[]): MessageContentBlock[] {
  return JSON.parse(JSON.stringify(content)) as MessageContentBlock[];
}
