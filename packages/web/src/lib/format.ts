import type { Message, SessionEvent, SessionSummary } from "@clawflare/types";

export type DisplayMessageRole = "user" | "assistant" | "system" | "toolResult" | "error";
export type ToolCallStatus = "pending" | "running" | "complete" | "error";

export interface ToolCallInfo {
  id: string;
  name: string;
  params: Record<string, unknown>;
  status: ToolCallStatus;
  result?: DisplayMessage;
  expanded?: boolean;
}

export interface DisplayMessage {
  id?: string;
  sequence?: number;
  role: DisplayMessageRole;
  content: string;
  toolName?: string;
  isError?: boolean;
  details?: unknown;
  streaming?: boolean;
  toolCalls?: ToolCallInfo[];
}

export function formatUpdatedAt(updatedAt: number): string {
  return new Date(updatedAt).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function formatSessionTitle(session: SessionSummary): string {
  return session.name || session.id.slice(0, 8);
}

export function getEventDisplayMessage(event: SessionEvent): string | null {
  switch (event.type) {
    case "message.created":
    case "message.updated": {
      const runningTool = event.message.content.find((block) => block.type === "tool_call" && block.status === "running");
      if (runningTool?.type === "tool_call") return `Running ${runningTool.name}`;
      return getEventMessageRole(event) === "assistant" ? "Generating response" : null;
    }
    case "message.completed":
      return getEventMessageRole(event) === "assistant" ? "Response ready" : null;
    case "message.errored":
      return "Message failed";
    case "session.status_changed":
      return event.status === "idle" ? "Complete" : event.status;
    default:
      return "Processing";
  }
}

export function formatToolCallHeader(toolName: string, params: Record<string, unknown>): string {
  switch (toolName) {
    case "execute_code":
      return stringParam(params, "description") ?? truncatePrefixed("Execute", stringParam(params, "code")) ?? "Execute code";
    case "execute_stored_code":
      return joinNamed("Run", stringParam(params, "name"), stringParam(params, "description")) ?? "Execute stored code";
    case "store_code":
      return joinNamed("Store", stringParam(params, "name"), stringParam(params, "description")) ?? "Store code";
    case "search":
      return stringParam(params, "query") ? `Search: "${stringParam(params, "query")}"` : "Search";
    case "container_bash":
      return stringParam(params, "command") ? `container_bash: "${truncate(stringParam(params, "command")!, 48)}"` : "container_bash";
    case "container_ls":
    case "container_read":
    case "container_write":
    case "container_edit":
      return stringParam(params, "path") ? `${toolName}: ${stringParam(params, "path")}` : toolName;
    case "container_grep":
      return stringParam(params, "pattern") ? `${toolName}: "${stringParam(params, "pattern")}"` : toolName;
    case "container_find":
      return stringParam(params, "name") ? `${toolName}: "${stringParam(params, "name")}"` : toolName;
    case "container_create":
      return stringParam(params, "description") ?? "container_create";
    default: {
      const args = Object.entries(params)
        .filter(([key]) => key !== "maxResponseLength")
        .slice(0, 2)
        .map(([key, value]) => `${key}: ${typeof value === "string" ? `"${truncate(value, 24)}"` : String(value)}`);
      return args.length ? `${toolName}(${args.join(", ")})` : toolName;
    }
  }
}

export function formatMessageForDisplay(message: Message): DisplayMessage {
  const role = toDisplayRole(message.role);
  const content = getMessageContent(message);

  if (role === "assistant") {
    const toolCalls = extractToolCalls(content);
    return {
      id: message.id,
      sequence: message.sequence,
      role,
      content: extractTextContent(content),
      streaming: message.status !== "complete",
      toolCalls: toolCalls.length ? toolCalls : undefined,
    };
  }

  return {
    id: message.id,
    sequence: message.sequence,
    role,
    content: extractTextContent(content),
    streaming: message.status !== "complete",
  };
}

export function formatMessagesFromEvents(events: SessionEvent[]): DisplayMessage[] {
  const messages: Message[] = [];
  const byId = new Map<string, number>();

  for (const event of events) {
    if (event.type === "message.created") {
      byId.set(event.message.id, messages.length);
      messages.push(event.message);
      continue;
    }

    if (event.type === "message.updated" || event.type === "message.completed") {
      const index = byId.get(event.message.id);
      if (index === undefined) {
        byId.set(event.message.id, messages.length);
        messages.push(event.message);
      } else {
        messages[index] = event.message;
      }
    }
  }

  return messages
    .sort((a, b) => a.sequence - b.sequence)
    .map(formatMessageForDisplay);
}

export function attachToolResults(messages: DisplayMessage[]): DisplayMessage[] {
  return messages.map((message) => ({
    ...message,
    toolCalls: message.toolCalls?.map((toolCall) => ({ ...toolCall })),
  }));
}

export function applyAssistantPartialEvents(messages: DisplayMessage[], events: SessionEvent[]): DisplayMessage[] {
  let next = [...messages];
  const ensureAssistant = (message: Message): number => {
    const byId = next.findIndex((candidate) => candidate.id === message.id);
    if (byId !== -1) return byId;

    const last = next[next.length - 1];
    if (last?.role === "assistant" && !last.id) return next.length - 1;

    next = [
      ...next,
      {
        id: message.id,
        sequence: message.sequence,
        role: "assistant",
        content: "",
        streaming: true,
      },
    ];
    return next.length - 1;
  };

  for (const event of events) {
    if (!("message" in event)) continue;
    if (eventMessageRole(event.message) !== "assistant") continue;

    const index = ensureAssistant(event.message);
    const content = getMessageContent(event.message);
    const toolCalls = extractToolCalls(content);
    next[index] = {
      ...next[index]!,
      id: event.message.id,
      sequence: event.message.sequence,
      content: extractTextContent(content),
      streaming: event.message.status !== "complete",
      toolCalls: toolCalls.length ? toolCalls : next[index]!.toolCalls,
    };
  }

  return updateToolCallStatusesFromEvents(sortDisplayMessages(next), events);
}

export function updateToolCallStatusesFromEvents(messages: DisplayMessage[], events: SessionEvent[]): DisplayMessage[] {
  return messages.map((message) => {
    if (message.role !== "assistant" || !message.toolCalls?.length) return message;
    return {
      ...message,
      toolCalls: message.toolCalls.map((toolCall) => {
        const block = [...events]
          .reverse()
          .flatMap((event) => "message" in event ? event.message.content : [])
          .find((candidate) => candidate.type === "tool_call" && candidate.id === toolCall.id);
        if (block?.type === "tool_call") return toolCallFromBlock(block as unknown as Record<string, unknown>);
        return toolCall;
      }),
    };
  });
}

export function isSessionComplete(status: string): boolean {
  return status === "idle" || status === "error" || status === "closed" || status === "expired";
}

function getEventMessageRole(event: SessionEvent): string | undefined {
  if (!("message" in event)) return undefined;
  return eventMessageRole(event.message);
}

function eventMessageRole(message: Message): string | undefined {
  return typeof message.role === "string" ? message.role : undefined;
}

function toDisplayRole(role: string): DisplayMessageRole {
  if (role === "user" || role === "assistant" || role === "system") return role;
  return "error";
}

function getMessageContent(message: Message): string | Array<Record<string, unknown>> | undefined {
  if (!("content" in message)) return undefined;
  return message.content as unknown as string | Array<Record<string, unknown>> | undefined;
}

function extractTextContent(content: string | Array<Record<string, unknown>> | undefined): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  return content
    .filter((part) => part.type === "text")
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .join("");
}

function extractToolCalls(content: string | Array<Record<string, unknown>> | undefined): ToolCallInfo[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter((part) => part.type === "toolCall" || part.type === "tool_call")
    .map(toolCallFromBlock);
}

function toolCallFromBlock(part: Record<string, unknown>): ToolCallInfo {
  const result = isRecord(part.result) ? part.result : undefined;
  return {
    id: typeof part.id === "string" ? part.id : "",
    name: typeof part.name === "string" ? part.name : "tool",
    params: isRecord(part.arguments) ? part.arguments : isRecord(part.input) ? part.input : {},
    status: toolCallStatus(part.status),
    result: result
      ? {
          role: "toolResult",
          toolName: typeof part.name === "string" ? part.name : "tool",
          isError: Boolean(result.isError),
          details: result.output,
          content: typeof result.text === "string" ? result.text : JSON.stringify(result.output),
        }
      : undefined,
  };
}

function toolCallStatus(value: unknown): ToolCallStatus {
  return value === "running" || value === "complete" || value === "error" ? value : "pending";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sortDisplayMessages(messages: DisplayMessage[]): DisplayMessage[] {
  return [...messages].sort((a, b) => {
    if (typeof a.sequence === "number" && typeof b.sequence === "number") return a.sequence - b.sequence;
    return 0;
  });
}

function stringParam(value: Record<string, unknown>, key: string): string | undefined {
  return typeof value[key] === "string" ? value[key] : undefined;
}

function truncate(value: string, length: number): string {
  return value.length > length ? `${value.slice(0, length)}...` : value;
}

function truncatePrefixed(prefix: string, value?: string): string | undefined {
  return value ? `${prefix}: ${truncate(value.replace(/\n/g, " "), 40)}` : undefined;
}

function joinNamed(prefix: string, name?: string, description?: string): string | undefined {
  if (name && description) return `${prefix} ${name}: ${description}`;
  if (name) return `${prefix} ${name}`;
  return undefined;
}
