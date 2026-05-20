/**
 * Agent Client - Communicates with the Clawflare harness
 * 
 * Session-based API - no workflow concepts exposed
 * - submitChat() returns sessionId for polling
 * - getSession() polls for messages and events
 * - Workflows are an internal implementation detail
 */

import WebSocket from "ws";
import type { 
  AgentMessage,
  SessionEvent,
  SessionResponse,
  ChatSubmittedResponse,
  ChatRequest,
} from "@clawflare/harness";

export type {
  AgentMessage,
  SessionEvent,
  SessionResponse,
  ChatSubmittedResponse,
  ChatRequest,
};

export interface StorageQuotaErrorDetails {
  requestedSize: number;
  limit: number;
  key: string;
  messageSize: number;
  messageCount: number;
  suggestedAction: string;
}

export interface ApiError {
  error: string;
  details?: StorageQuotaErrorDetails;
  hint?: string;
}

export interface ChatUsage {
  input: number;
  output: number;
  totalTokens: number;
}

export interface ContextInfo {
  id: string;
  parentId?: string;
  messages: AgentMessage[];
  createdAt: number;
}

export interface ToolInfo {
  name: string;
  description: string;
  parameters: unknown;
}

export interface ServerInfo {
  provider: string;
  model: string;
  contextWindow: number;
}

export class AgentClient {
  private url: string;
  private token: string;
  private ws?: WebSocket;
  private currentContextId: string | null = null;

  constructor(url: string, token: string) {
    this.url = url;
    this.token = token;
  }

  private getHeaders(): Record<string, string> {
    return {
      "Authorization": `Bearer ${this.token}`,
      "Content-Type": "application/json",
    };
  }

  // Submit a chat prompt and get a session handle for polling
  async submitChat(request: ChatRequest): Promise<ChatSubmittedResponse> {
    const requestWithContext: ChatRequest = {
      ...request,
      sessionId: request.sessionId ?? this.currentContextId ?? undefined,
    };

    const response = await fetch(`${this.url}/v1/chat`, {
      method: "POST",
      headers: this.getHeaders(),
      body: JSON.stringify(requestWithContext),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      const errorData = JSON.parse(errorBody) as ApiError;
      throw new Error(formatApiError(response.status, errorData));
    }

    const data = await response.json() as ChatSubmittedResponse;
    if (data.sessionId) this.currentContextId = data.sessionId;
    return data;
  }

  // Get current session state (poll for updates)
  async getSession(sessionId: string, eventCursor?: string): Promise<SessionResponse> {
    const url = new URL(`${this.url}/v1/session/${sessionId}`);
    if (eventCursor) url.searchParams.set("since", eventCursor);

    const response = await fetch(url, {
      method: "GET",
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      const errorData = JSON.parse(errorBody) as ApiError;
      throw new Error(formatApiError(response.status, errorData));
    }

    return response.json() as Promise<SessionResponse>;
  }

  // Poll session until complete, yielding updates
  async *streamSession(
    sessionId: string,
    signal?: AbortSignal,
    options: { pollIntervalMs?: number; maxPolls?: number; initialCursor?: string } = {},
  ): AsyncGenerator<{ session: SessionResponse; newEvents: SessionEvent[]; complete: boolean }> {
    const pollIntervalMs = options.pollIntervalMs ?? 500;
    const maxPolls = options.maxPolls ?? 300;
    let cursor: string | undefined = options.initialCursor;

    for (let poll = 0; poll < maxPolls; poll++) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      const session = await this.getSession(sessionId, cursor);
      
      const newEvents = session.events;
      const complete = session.status === "idle" || session.status === "error";
      
      yield { session, newEvents, complete };
      
      if (complete) return;
      
      cursor = session.nextEventCursor;
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    throw new Error(`Session ${sessionId} did not complete before polling timed out`);
  }

  async getContext(): Promise<ContextInfo> {
    const response = await fetch(`${this.url}/v1/context`, {
      method: "GET",
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      throw new Error(`Failed to get context: ${response.status} - ${errorText}`);
    }

    const data = await response.json() as ContextInfo;
    this.currentContextId = data.id;
    return data;
  }

  async createContext(parentId?: string): Promise<ContextInfo> {
    const response = await fetch(`${this.url}/v1/context`, {
      method: "POST",
      headers: this.getHeaders(),
      body: JSON.stringify({ parentId }),
    });

    if (!response.ok) {
      throw new Error(`Failed to create context: ${response.status}`);
    }

    const data = await response.json() as ContextInfo;
    this.currentContextId = data.id;
    return data;
  }

  async forkContext(): Promise<ContextInfo> {
    return this.createContext(this.currentContextId || undefined);
  }

  async listTools(): Promise<ToolInfo[]> {
    const response = await fetch(`${this.url}/v1/tools`, {
      method: "GET",
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      throw new Error(`Failed to list tools: ${response.status}`);
    }

    const data = await response.json() as { tools: ToolInfo[] };
    return data.tools || [];
  }

  // WebSocket for streaming responses
  async connectWebSocket(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${this.url.replace(/^http/, "ws")}/ws`, {
        headers: this.getHeaders(),
      });

      ws.on("open", () => resolve(ws));
      ws.on("error", reject);
    });
  }

  getCurrentContextId(): string | null {
    return this.currentContextId;
  }

  getUrl(): string {
    return this.url;
  }

  async getServerInfo(): Promise<ServerInfo> {
    const response = await fetch(`${this.url}/v1/info`, {
      method: "GET",
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      throw new Error(`Failed to get server info: ${response.status}`);
    }

    return response.json() as Promise<ServerInfo>;
  }

  // Debug endpoint - inspect DO storage
  async cfDebug(sessionId?: string, key?: string): Promise<unknown> {
    const url = new URL(`${this.url}/v1/cf_debug`);
    if (sessionId) url.searchParams.set("sessionId", sessionId);
    if (key) url.searchParams.set("key", key);

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      throw new Error(`Debug query failed: ${response.status} - ${errorText}`);
    }

    return response.json();
  }
}

// Format API errors with rich context for display
function formatApiError(status: number, errorData: ApiError): string {
  const baseMessage = errorData.error || "Unknown error";
  
  // 413 Payload Too Large - storage quota exceeded
  if (status === 413 && errorData.details) {
    const d = errorData.details;
    return `Session storage limit exceeded:
  Session size: ${formatBytes(d.requestedSize)} (max ${formatBytes(d.limit)})
  Messages: ${d.messageCount} (${formatBytes(d.messageSize)})
  ${errorData.hint || d.suggestedAction}`;
  }
  
  return baseMessage;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
