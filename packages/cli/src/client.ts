/**
 * Agent Client - Communicates with the Clawflare harness
 * 
 * Session-based API - no workflow concepts exposed
 * - submitChat() returns sessionId for polling
 * - streamSession() streams session events when available and falls back to polling
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
  ModelConnection,
  ModelConnectionListResponse,
  CreateModelConnectionRequest,
  UpdateModelConnectionRequest,
  CreateSessionRequest,
  CreateSessionResponse,
  KillSessionResponse,
  ProviderInfo,
  ProviderListResponse,
  ProviderModelInfo,
  ProviderModelsResponse,
  EgressHandlerInfo,
  EgressHandlerListResponse,
  ConfigureEgressHandlerRequest,
  UpdateEgressHandlerRequest,
} from "@clawflare/types";

export type {
  AgentMessage,
  SessionEvent,
  SessionResponse,
  ChatSubmittedResponse,
  ChatRequest,
  SessionListResponse,
  SessionSummary,
  ModelConnection,
  ModelConnectionListResponse,
  CreateModelConnectionRequest,
  UpdateModelConnectionRequest,
  CreateSessionRequest,
  CreateSessionResponse,
  KillSessionResponse,
  ProviderInfo,
  ProviderListResponse,
  ProviderModelInfo,
  ProviderModelsResponse,
  EgressHandlerInfo,
  EgressHandlerListResponse,
  ConfigureEgressHandlerRequest,
  UpdateEgressHandlerRequest,
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

export interface ToolInfo {
  name: string;
  description: string;
  parameters: unknown;
}

export interface ServerInfo {
  contextWindow: number;
  supportsWorkspaceModelConnections: boolean;
  supportedProviders: string[];
  workspace?: {
    hasModelConnections: boolean;
  };
}

interface DeleteEgressHandlerResponse {
  ok: boolean;
  egressHandlerId: string;
}

const SESSION_EVENT_PAGE_SIZE = 100;
type SessionStreamTransport = "auto" | "sse" | "poll";
type SessionStreamUpdate = { session: SessionResponse; newEvents: SessionEvent[]; complete: boolean };

export class AgentClient {
  private url: string;
  private token: string;
  private workspace?: string;
  private ws?: WebSocket;
  private currentSessionId: string | null = null;

  constructor(url: string, token: string, workspace?: string) {
    // Require HTTPS for security - reject plain HTTP
    const urlObj = new URL(url);
    if (urlObj.protocol !== "https:") {
      throw new Error(
        `Insecure server URL: ${url}. HTTPS is required. Clawflare CLI does not support HTTP servers.`
      );
    }
    this.url = url;
    this.token = token;
    this.workspace = workspace;
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

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const url = this.buildUrl(path);
    return fetch(url, {
      ...init,
      headers: {
        ...this.getHeaders(),
        ...(init.headers || {}),
      },
    });
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
      sessionId: request.sessionId ?? this.currentSessionId ?? undefined,
    };

    const data = await this.requestJson<ChatSubmittedResponse>("/v1/chat", {
      method: "POST",
      body: JSON.stringify(requestWithContext),
    });

    if (data.sessionId) this.currentSessionId = data.sessionId;
    return data;
  }

  // Close an active session
  async closeSession(sessionId: string): Promise<{ ok: boolean; sessionId: string; status: string }> {
    return this.requestJson<{ ok: boolean; sessionId: string; status: string }>(
      `/v1/session/${sessionId}/close`,
      { method: "POST" }
    );
  }

  async killSession(sessionId: string): Promise<KillSessionResponse> {
    return this.requestJson<KillSessionResponse>(
      `/v1/session/${sessionId}/kill`,
      { method: "POST" }
    );
  }

  // List sessions - optional status filter ("active", "idle", "closed", "expired", "error")
  async listSessions(options?: { status?: string; sessionId?: string; limit?: number; offset?: number }): Promise<SessionListResponse> {
    const query = new URLSearchParams();
    if (options?.status && options.status !== "all") query.set("status", options.status);
    if (options?.sessionId) query.set("sessionId", options.sessionId);
    if (options?.limit !== undefined) query.set("limit", String(options.limit));
    if (options?.offset !== undefined) query.set("offset", String(options.offset));

    const path = `/v1/sessions${query.toString() ? `?${query.toString()}` : ""}`;
    return this.requestJson<SessionListResponse>(path);
  }

  // Get current session state (poll for updates)
  async getSession(
    sessionId: string,
    eventCursor?: string,
    options: { includeMessages?: boolean | "auto" } = {},
  ): Promise<SessionResponse> {
    const query = new URLSearchParams();
    if (eventCursor) query.set("since", eventCursor);
    if (options.includeMessages !== undefined) {
      query.set(
        "includeMessages",
        options.includeMessages === "auto"
          ? "auto"
          : options.includeMessages
            ? "1"
            : "0",
      );
    }

    const path = `/v1/session/${sessionId}${query.toString() ? `?${query.toString()}` : ""}`;
    return this.requestJson<SessionResponse>(path);
  }

  async renameSession(sessionId: string, name: string): Promise<{ ok: boolean; sessionId: string; name: string }> {
    return this.requestJson<{ ok: boolean; sessionId: string; name: string }>(
      `/v1/session/${sessionId}/name`,
      {
        method: "POST",
        body: JSON.stringify({ name }),
      }
    );
  }

  // Poll session until complete, yielding updates
  async *streamSession(
    sessionId: string,
    signal?: AbortSignal,
    options: {
      pollIntervalMs?: number;
      maxPolls?: number;
      initialCursor?: string;
      debug?: boolean;
      transport?: SessionStreamTransport;
    } = {},
  ): AsyncGenerator<SessionStreamUpdate> {
    const transport = options.transport ?? "auto";

    if (transport !== "poll") {
      let streamed = false;
      try {
        for await (const update of this.streamSessionEvents(sessionId, signal, options)) {
          streamed = true;
          yield update;
        }
        return;
      } catch (error) {
        if (transport === "sse" || streamed || signal?.aborted) throw error;
        if (options.debug) {
          console.log(`[streamSession] SSE unavailable, falling back to polling: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }

    yield* this.pollSession(sessionId, signal, options);
  }

  private async *pollSession(
    sessionId: string,
    signal?: AbortSignal,
    options: { pollIntervalMs?: number; maxPolls?: number; initialCursor?: string; debug?: boolean } = {},
  ): AsyncGenerator<SessionStreamUpdate> {
    const pollIntervalMs = options.pollIntervalMs ?? 250;
    const maxPolls = options.maxPolls ?? 10000;
    let cursor: string | undefined = options.initialCursor;

    for (let poll = 0; poll < maxPolls; poll++) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      const session = await this.getSession(sessionId, cursor, { includeMessages: "auto" });
      
      const newEvents = session.events;
      const sessionComplete = session.status === "idle" ||
        session.status === "error" ||
        session.status === "closed" ||
        session.status === "expired";
      const mayHaveMoreEvents = sessionComplete && newEvents.length >= SESSION_EVENT_PAGE_SIZE;
      const complete = sessionComplete && !mayHaveMoreEvents;
      
      if (options.debug) {
        console.log(`[streamSession] poll=${poll} status=${session.status} events=${newEvents.length} complete=${complete} cursor=${cursor ?? "0"}`);
      }
      
      yield { session, newEvents, complete };
      
      cursor = session.nextEventCursor;

      if (complete) {
        if (options.debug) {
          console.log(`[streamSession] polling complete - status=${session.status}`);
        }
        return;
      }
      
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    throw new Error(`Session ${sessionId} did not complete before polling timed out`);
  }

  private async *streamSessionEvents(
    sessionId: string,
    signal?: AbortSignal,
    options: { initialCursor?: string; debug?: boolean } = {},
  ): AsyncGenerator<SessionStreamUpdate> {
    const query = new URLSearchParams();
    if (options.initialCursor) query.set("since", options.initialCursor);
    query.set("includeMessages", "auto");

    const path = `/v1/session/${sessionId}/events?${query.toString()}`;
    const response = await this.request(path, {
      method: "GET",
      headers: { Accept: "text/event-stream" },
      signal,
    });

    if (!response.ok) {
      const errorData = await this.parseApiError(response);
      throw new Error(formatApiError(response.status, errorData));
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/event-stream")) {
      throw new Error(`Expected text/event-stream response, got ${contentType || "unknown content type"}`);
    }

    if (!response.body) {
      throw new Error("Event stream response has no body");
    }

    for await (const event of parseServerSentEvents(response.body)) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      if (event.event === "heartbeat") continue;
      if (event.event === "error") {
        const parsed = safeJsonParse<{ error?: string }>(event.data);
        throw new Error(parsed?.error ?? "Session event stream failed");
      }
      if (event.event && event.event !== "session") continue;

      const session = safeJsonParse<SessionResponse>(event.data);
      if (!session) continue;

      const newEvents = session.events;
      const sessionComplete = session.status === "idle" ||
        session.status === "error" ||
        session.status === "closed" ||
        session.status === "expired";
      const mayHaveMoreEvents = sessionComplete && newEvents.length >= SESSION_EVENT_PAGE_SIZE;
      const complete = sessionComplete && !mayHaveMoreEvents;

      if (options.debug) {
        console.log(`[streamSession] sse status=${session.status} events=${newEvents.length} complete=${complete} cursor=${session.nextEventCursor}`);
      }

      yield { session, newEvents, complete };

      if (complete) {
        if (options.debug) {
          console.log(`[streamSession] SSE complete - status=${session.status}`);
        }
        return;
      }
    }

    throw new Error(`Session ${sessionId} event stream ended before completion`);
  }

  async createSession(input: CreateSessionRequest = {}): Promise<CreateSessionResponse> {
    const data = await this.requestJson<CreateSessionResponse>("/v1/session", {
      method: "POST",
      body: JSON.stringify(input),
    });
    this.currentSessionId = data.id;
    return data;
  }

  async warmupSession(): Promise<void> {
    await this.createSession();
  }

  async forkSession(input: {
    parentSessionId: string;
    parentMessageId: string;
    modelConnectionId?: string;
  }): Promise<CreateSessionResponse> {
    return this.createSession(input);
  }

  async listTools(): Promise<ToolInfo[]> {
    const { tools } = await this.requestJson<{ tools: ToolInfo[] }>("/v1/tools");
    return tools || [];
  }

  // WebSocket for streaming responses
  async connectWebSocket(): Promise<WebSocket> {
    const wsUrl = `${this.url.replace(/^https/, "wss")}/ws`;
    
    // Ensure we're using secure WebSocket (WSS)
    if (!wsUrl.startsWith("wss://")) {
      throw new Error(
        `Insecure WebSocket URL: ${wsUrl}. WSS (secure WebSocket) is required.`
      );
    }
    
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl, {
        headers: this.getHeaders(),
      });

      ws.on("open", () => resolve(ws));
      ws.on("error", reject);
    });
  }

  getCurrentSessionId(): string | null {
    return this.currentSessionId;
  }

  setCurrentSessionId(sessionId: string): void {
    this.currentSessionId = sessionId;
  }

  getCurrentContextId(): string | null {
    return this.getCurrentSessionId();
  }

  getUrl(): string {
    return this.url;
  }

  getToken(): string {
    return this.token;
  }

  async getServerInfo(): Promise<ServerInfo> {
    return this.requestJson<ServerInfo>("/v1/info");
  }

  async listProviders(): Promise<ProviderInfo[]> {
    const data = await this.requestJson<ProviderListResponse>("/v1/providers");
    return data.providers || [];
  }

  async listProviderModels(providerId: string): Promise<ProviderModelInfo[]> {
    const data = await this.requestJson<ProviderModelsResponse>(
      `/v1/providers/${encodeURIComponent(providerId)}/models`
    );
    return data.models || [];
  }

  async listAvailableEgressHandlers(): Promise<EgressHandlerInfo[]> {
    const data = await this.requestJson<EgressHandlerListResponse>("/v1/egress-handlers/available");
    return data.egressHandlers || [];
  }

  async listEgressHandlers(options?: { enabledOnly?: boolean }): Promise<EgressHandlerInfo[]> {
    const query = new URLSearchParams();
    if (options?.enabledOnly === false) query.set("enabledOnly", "false");
    const path = `/v1/egress-handlers${query.toString() ? `?${query.toString()}` : ""}`;
    const data = await this.requestJson<EgressHandlerListResponse>(path);
    return data.egressHandlers || [];
  }

  async configureEgressHandler(input: ConfigureEgressHandlerRequest): Promise<EgressHandlerInfo> {
    const data = await this.requestJson<{ egressHandler: EgressHandlerInfo }>("/v1/egress-handlers", {
      method: "POST",
      body: JSON.stringify(input),
    });
    return data.egressHandler;
  }

  async updateEgressHandler(egressHandlerId: string, input: UpdateEgressHandlerRequest): Promise<EgressHandlerInfo> {
    const data = await this.requestJson<{ egressHandler: EgressHandlerInfo }>(
      `/v1/egress-handlers/${encodeURIComponent(egressHandlerId)}`,
      {
        method: "PATCH",
        body: JSON.stringify(input),
      }
    );
    return data.egressHandler;
  }

  async deleteEgressHandler(egressHandlerId: string): Promise<DeleteEgressHandlerResponse> {
    return this.requestJson<DeleteEgressHandlerResponse>(
      `/v1/egress-handlers/${encodeURIComponent(egressHandlerId)}`,
      { method: "DELETE" }
    );
  }

  // Debug endpoint - inspect DO storage
  async cfDebug(sessionId?: string, key?: string): Promise<unknown> {
    const query = new URLSearchParams();
    if (sessionId) query.set("sessionId", sessionId);
    if (key) query.set("key", key);

    const path = `/v1/cf_debug${query.toString() ? `?${query.toString()}` : ""}`;
    return this.requestJson<unknown>(path);
  }

  // Model Connection API
  async listModelConnections(): Promise<ModelConnectionListResponse> {
    return this.requestJson<ModelConnectionListResponse>("/v1/model-connections");
  }

  async createModelConnection(input: CreateModelConnectionRequest): Promise<ModelConnection> {
    const data = await this.requestJson<{ modelConnection: ModelConnection }>("/v1/model-connections", {
      method: "POST",
      body: JSON.stringify(input),
    });
    return data.modelConnection;
  }

  async updateModelConnection(
    id: string,
    input: UpdateModelConnectionRequest
  ): Promise<ModelConnection> {
    const data = await this.requestJson<{ modelConnection: ModelConnection }>(
      `/v1/model-connections/${id}`,
      {
        method: "PATCH",
        body: JSON.stringify(input),
      }
    );
    return data.modelConnection;
  }

  async deleteModelConnection(id: string): Promise<{ ok: boolean }> {
    return this.requestJson<{ ok: boolean }>(`/v1/model-connections/${id}`, {
      method: "DELETE",
    });
  }

  async setDefaultModelConnection(id: string | null): Promise<{
    ok: boolean;
    defaultModelConnectionId?: string;
  }> {
    return this.requestJson<{ ok: boolean; defaultModelConnectionId?: string }>(
      "/v1/workspace/default-model-connection",
      {
        method: "PUT",
        body: JSON.stringify({ modelConnectionId: id }),
      }
    );
  }
}

interface ParsedServerSentEvent {
  event?: string;
  data: string;
}

function safeJsonParse<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

async function* parseServerSentEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<ParsedServerSentEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      let separatorIndex = findEventSeparator(buffer);

      while (separatorIndex !== -1) {
        const rawEvent = buffer.slice(0, separatorIndex);
        buffer = buffer.slice(separatorIndex + eventSeparatorLength(buffer, separatorIndex));
        const event = parseServerSentEvent(rawEvent);
        if (event) yield event;
        separatorIndex = findEventSeparator(buffer);
      }
    }

    buffer += decoder.decode();
    const event = parseServerSentEvent(buffer);
    if (event) yield event;
  } finally {
    reader.releaseLock();
  }
}

function findEventSeparator(value: string): number {
  const candidates = [
    value.indexOf("\n\n"),
    value.indexOf("\r\r"),
    value.indexOf("\r\n\r\n"),
  ].filter((index) => index !== -1);
  return candidates.length === 0 ? -1 : Math.min(...candidates);
}

function eventSeparatorLength(value: string, index: number): number {
  return value.startsWith("\r\n\r\n", index) ? 4 : 2;
}

function parseServerSentEvent(rawEvent: string): ParsedServerSentEvent | null {
  const lines = rawEvent.split(/\r?\n|\r/);
  const data: string[] = [];
  let event: string | undefined;

  for (const line of lines) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");

    if (field === "event") event = value;
    if (field === "data") data.push(value);
  }

  if (!event && data.length === 0) return null;
  return { event, data: data.join("\n") };
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
