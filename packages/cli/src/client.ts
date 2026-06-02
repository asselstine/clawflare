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
    options: { pollIntervalMs?: number; maxPolls?: number; initialCursor?: string; debug?: boolean } = {},
  ): AsyncGenerator<{ session: SessionResponse; newEvents: SessionEvent[]; complete: boolean }> {
    const pollIntervalMs = options.pollIntervalMs ?? 250;
    const maxPolls = options.maxPolls ?? 10000;
    let cursor: string | undefined = options.initialCursor;

    for (let poll = 0; poll < maxPolls; poll++) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      const session = await this.getSession(sessionId, cursor, { includeMessages: "auto" });
      
      const newEvents = session.events;
      const sessionComplete = session.status === "idle" || session.status === "error";
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
