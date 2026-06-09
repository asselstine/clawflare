import type { AgentClient } from "../../cli/src/client.js";

export interface E2ETestRunner {
  runTest(name: string, testFn: () => Promise<void>): Promise<void>;
}

export interface ToolInvokeResponse<TDetails = unknown> {
  tool: string;
  result: {
    content: Array<{ type: string; text?: string }>;
    details: TDetails;
  };
}

export interface E2ETestContext {
  url: string;
  token: string;
  client: AgentClient;
  authedFetch(path: string, init?: RequestInit): Promise<Response>;
  authedJson<T>(path: string, init?: RequestInit): Promise<T>;
  createToolSession(): Promise<string>;
  invokeTool<TDetails = unknown>(
    name: string,
    input: unknown,
    sessionId?: string,
    toolRunState?: unknown
  ): Promise<ToolInvokeResponse<TDetails>>;
  trackTestContainer(containerId: string, sessionId: string): void;
  destroyTestContainer(containerId: string, sessionId: string): Promise<void>;
}

export async function readJsonResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    const preview = text.length > 1000 ? `${text.slice(0, 1000)}...` : text;
    throw new Error(`Expected JSON response, got HTTP ${response.status} ${response.statusText}: ${preview}`);
  }
}

export function messageText(message: { content: string | Array<{ type: string; text?: string }> }): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("");
}
