import type { AgentMessage, SessionEvent, SessionSummary } from "@clawflare/types";

export type DisplayMessageRole = "user" | "assistant" | "toolResult" | "error";
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
    case "tool_execution_start":
      return `Running ${event.toolName}`;
    case "tool_execution_end":
      return `${event.toolName} ${event.isError ? "failed" : "completed"}`;
    case "tool_execution_update":
      return `${event.toolName} updating`;
    case "agent_start":
      return "Agent started";
    case "agent_end":
      return "Complete";
    case "turn_start":
      return "Turn started";
    case "turn_end":
      return "Turn completed";
    case "message_start":
    case "message_update":
      return getEventMessageRole(event) === "assistant" ? "Generating response" : null;
    case "message_end":
      return getEventMessageRole(event) === "assistant" ? "Response ready" : null;
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

export function formatMessageForDisplay(message: AgentMessage): DisplayMessage {
  const role = toDisplayRole(message.role);
  const content = getMessageContent(message);

  if (role === "assistant") {
    const toolCalls = extractToolCalls(content);
    return {
      role,
      content: extractTextContent(content),
      toolCalls: toolCalls.length ? toolCalls : undefined,
    };
  }

  if (role !== "toolResult") {
    return { role, content: extractTextContent(content) };
  }

  const toolMessage = message as AgentMessage & {
    toolName?: string;
    isError?: boolean;
    details?: unknown;
  };
  const toolName = toolMessage.toolName ?? "tool";

  return {
    role,
    toolName,
    isError: getPersistedToolResultIsError(toolMessage),
    details: toolMessage.details,
    content: `${toolName}: ${extractTextContent(content)}`,
  };
}

export function formatMessagesFromEvents(events: SessionEvent[]): DisplayMessage[] {
  return events
    .filter((event) => event.type === "message_end" && "message" in event)
    .map((event) => formatMessageForDisplay(event.message));
}

export function attachToolResults(messages: DisplayMessage[]): DisplayMessage[] {
  const next = messages.map((message) => ({
    ...message,
    toolCalls: message.toolCalls?.map((toolCall) => ({ ...toolCall })),
  }));
  const assistantToolCallIndex = new Map<number, number>();

  for (let i = 0; i < next.length; i++) {
    const msg = next[i];
    if (msg?.role !== "toolResult" || !msg.toolName) continue;

    for (let j = i - 1; j >= 0; j--) {
      const assistant = next[j];
      if (assistant?.role !== "assistant" || !assistant.toolCalls?.length) continue;

      const toolIndex = assistantToolCallIndex.get(j) ?? 0;
      if (toolIndex < assistant.toolCalls.length) {
        assistant.toolCalls[toolIndex] = {
          ...assistant.toolCalls[toolIndex]!,
          result: msg,
          status: msg.isError ? "error" : "complete",
        };
        assistantToolCallIndex.set(j, toolIndex + 1);
      }
      break;
    }
  }

  return next.filter((message) => message.role !== "toolResult");
}

export function applyAssistantPartialEvents(messages: DisplayMessage[], events: SessionEvent[]): DisplayMessage[] {
  let next = [...messages];
  const ensureAssistant = (): number => {
    const last = next[next.length - 1];
    if (last?.role === "assistant") return next.length - 1;
    next = [...next, { role: "assistant", content: "", streaming: true }];
    return next.length - 1;
  };

  for (const event of events) {
    if (!("message" in event)) continue;
    if (event.type !== "message_start" && event.type !== "message_update" && event.type !== "message_end") continue;
    if (eventMessageRole(event.message) !== "assistant") continue;

    const index = ensureAssistant();
    const content = getMessageContent(event.message);
    const toolCalls = extractToolCalls(content);
    next[index] = {
      ...next[index]!,
      content: extractTextContent(content),
      streaming: event.type !== "message_end",
      toolCalls: toolCalls.length ? toolCalls : next[index]!.toolCalls,
    };
  }

  return updateToolCallStatusesFromEvents(next, events);
}

export function updateToolCallStatusesFromEvents(messages: DisplayMessage[], events: SessionEvent[]): DisplayMessage[] {
  return messages.map((message) => {
    if (message.role !== "assistant" || !message.toolCalls?.length) return message;
    return {
      ...message,
      toolCalls: message.toolCalls.map((toolCall) => {
        const event = [...events].reverse().find((candidate) => "toolCallId" in candidate && candidate.toolCallId === toolCall.id);
        if (!event) return toolCall;
        if (event.type === "tool_execution_start") return { ...toolCall, status: "running" };
        if (event.type === "tool_execution_end") return { ...toolCall, status: event.isError ? "error" : "complete" };
        if (event.type === "tool_execution_update" && "status" in event) {
          const status = event.status;
          if (status === "running" || status === "complete" || status === "error") return { ...toolCall, status };
        }
        return toolCall;
      }),
    };
  });
}

export function isSessionComplete(status: string, eventCount: number): boolean {
  const done = status === "idle" || status === "error" || status === "closed" || status === "expired";
  return done && eventCount < 100;
}

function getEventMessageRole(event: SessionEvent): string | undefined {
  if (!("message" in event)) return undefined;
  return eventMessageRole(event.message);
}

function eventMessageRole(message: AgentMessage): string | undefined {
  return typeof message.role === "string" ? message.role : undefined;
}

function toDisplayRole(role: string): DisplayMessageRole {
  if (role === "user" || role === "assistant" || role === "toolResult") return role;
  return "error";
}

function getMessageContent(message: AgentMessage): string | Array<Record<string, unknown>> | undefined {
  if (!("content" in message)) return undefined;
  return message.content as string | Array<Record<string, unknown>> | undefined;
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
    .filter((part) => part.type === "toolCall")
    .map((part) => ({
      id: typeof part.id === "string" ? part.id : "",
      name: typeof part.name === "string" ? part.name : "tool",
      params: isRecord(part.arguments) ? part.arguments : {},
      status: "pending",
    }));
}

function getPersistedToolResultIsError(toolResult: { isError?: boolean; details?: unknown }): boolean {
  const details = toolResult.details;
  return Boolean(toolResult.isError) || (isRecord(details) && details.ok === false);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
