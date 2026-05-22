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
  SessionListResponse,
  SessionSummary,
} from "@clawflare/harness";

export type {
  AgentMessage,
  SessionEvent,
  SessionResponse,
  ChatSubmittedResponse,
  ChatRequest,
  SessionListResponse,
  SessionSummary,
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

  /**
   * Make a JSON request and return the parsed response
   */
  private async requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
    const url = this.buildUrl(path);
    const response = await fetch(url, {
      ...init,
      headers: {
        ...this.getHeaders(),
        ...(init.headers || {}),
      },
    });

    return this.parseJsonResponse<T>(response);
  }

  /**
   * Build a URL from a path
   */
  private buildUrl(path: string): string {
    return `${this.url}${path}`;
  }

  /**
   * Parse a response as JSON, handling errors
   */
  private async parseJsonResponse<T>(response: Response): Promise<T> {
    if (!response.ok) {
      const errorData = await this.parseApiError(response);
      throw new Error(formatApiError(response.status, errorData));
    }

    return response.json() as Promise<T>;
  }

  /**
   * Parse an API error response
   */
  private async parseApiError(response: Response): Promise<ApiError> {
    const errorText = await response.text().catch(() => "Unknown error");
    try {
      return JSON.parse(errorText) as ApiError;
    } catch {
      return { error: errorText };
    }
  }

  // Submit a chat prompt and get a session handle for polling
  async submitChat(request: ChatRequest): Promise<ChatSubmittedResponse> {
    const requestWithContext: ChatRequest = {
      ...request,
      sessionId: request.sessionId ?? this.currentContextId ?? undefined,
    };

    const data = await this.requestJson<ChatSubmittedResponse>("/v1/chat", {
      method: "POST",
      body: JSON.stringify(requestWithContext),
    });

    if (data.sessionId) this.currentContextId = data.sessionId;
    return data;
  }

  // Close an active session
  async closeSession(sessionId: string): Promise<{ ok: boolean; sessionId: string; status: string }> {
    return this.requestJson<{ ok: boolean; sessionId: string; status: string }>(
      `/v1/session/${sessionId}/close`,
      { method: "POST" }
    );
  }

  // List sessions - optional status filter ("active", "idle", "closed", "expired", "error")
  async listSessions(options?: { status?: string; sessionId?: string }): Promise<SessionListResponse> {
    const query = new URLSearchParams();
    if (options?.status && options.status !== "all") query.set("status", options.status);
    if (options?.sessionId) query.set("sessionId", options.sessionId);

    const path = `/v1/sessions${query.toString() ? `?${query.toString()}` : ""}`;
    return this.requestJson<SessionListResponse>(path);
  }

  // Get current session state (poll for updates)
  async getSession(sessionId: string, eventCursor?: string): Promise<SessionResponse> {
    const query = new URLSearchParams();
    if (eventCursor) query.set("since", eventCursor);

    const path = `/v1/session/${sessionId}${query.toString() ? `?${query.toString()}` : ""}`;
    return this.requestJson<SessionResponse>(path);
  }

  // Poll session until complete, yielding updates
  async *streamSession(
    sessionId: string,
    signal?: AbortSignal,
    options: { pollIntervalMs?: number; maxPolls?: number; initialCursor?: string; debug?: boolean } = {},
  ): AsyncGenerator<{ session: SessionResponse; newEvents: SessionEvent[]; complete: boolean }> {
    const pollIntervalMs = options.pollIntervalMs ?? 250;
    const maxPolls = options.maxPolls ?? 10000;
    let cursor: string | undefined = options.initialCursor;

    for (let poll = 0; poll < maxPolls; poll++) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      const session = await this.getSession(sessionId, cursor);
      
      const newEvents = session.events;
      const complete = session.status === "idle" || session.status === "error";
      
      if (options.debug) {
        console.log(`[streamSession] poll=${poll} status=${session.status} events=${newEvents.length} complete=${complete} cursor=${cursor ?? "0"}`);
      }
      
      yield { session, newEvents, complete };
      
      if (complete) {
        if (options.debug) {
          console.log(`[streamSession] polling complete - status=${session.status}`);
        }
        return;
      }
      
      cursor = session.nextEventCursor;
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    throw new Error(`Session ${sessionId} did not complete before polling timed out`);
  }

  async getContext(): Promise<ContextInfo> {
    const data = await this.requestJson<ContextInfo>("/v1/context");
    this.currentContextId = data.id;
    return data;
  }

  async createSession(): Promise<ContextInfo> {
    const data = await this.requestJson<ContextInfo>("/v1/session", {
      method: "POST",
    });
    this.currentContextId = data.id;
    return data;
  }

  async warmupSession(): Promise<void> {
    // Create a throwaway session to warm up the workflow isolate
    await this.requestJson<ContextInfo>("/v1/session", {
      method: "POST",
    });
  }

  async createContext(parentId?: string): Promise<ContextInfo> {
    const data = await this.requestJson<ContextInfo>("/v1/context", {
      method: "POST",
      body: JSON.stringify({ parentId }),
    });

    this.currentContextId = data.id;
    return data;
  }

  async forkContext(): Promise<ContextInfo> {
    return this.createContext(this.currentContextId || undefined);
  }

  async listTools(): Promise<ToolInfo[]> {
    const { tools } = await this.requestJson<{ tools: ToolInfo[] }>("/v1/tools");
    return tools || [];
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
    return this.requestJson<ServerInfo>("/v1/info");
  }

  // Debug endpoint - inspect DO storage
  async cfDebug(sessionId?: string, key?: string): Promise<unknown> {
    const query = new URLSearchParams();
    if (sessionId) query.set("sessionId", sessionId);
    if (key) query.set("key", key);

    const path = `/v1/cf_debug${query.toString() ? `?${query.toString()}` : ""}`;
    return this.requestJson<unknown>(path);
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
