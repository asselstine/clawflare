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
  Message,
  SessionEvent,
  SessionResponse,
  ChatSubmittedResponse,
  ChatRequest,
  SessionListResponse,
  SessionSummary,
  Model,
  ModelListResponse,
  CreateModelRequest,
  UpdateModelRequest,
  CreateSessionRequest,
  CreateSessionResponse,
  KillSessionResponse,
  DeleteSessionResponse,
  DeleteSessionsResponse,
  ProviderInfo,
  ProviderListResponse,
  ProviderModelInfo,
  ProviderModelsResponse,
  EgressHandlerInfo,
  EgressHandlerListResponse,
  ConfigureEgressHandlerRequest,
  UpdateEgressHandlerRequest,
  WorkspaceProvider,
  WorkspaceProviderListResponse,
} from "@clawflare/types";

export type {
  AgentMessage,
  Message,
  SessionEvent,
  SessionResponse,
  ChatSubmittedResponse,
  ChatRequest,
  SessionListResponse,
  SessionSummary,
  Model,
  ModelListResponse,
  CreateModelRequest,
  UpdateModelRequest,
  CreateSessionRequest,
  CreateSessionResponse,
  KillSessionResponse,
  DeleteSessionResponse,
  DeleteSessionsResponse,
  ProviderInfo,
  ProviderListResponse,
  ProviderModelInfo,
  ProviderModelsResponse,
  EgressHandlerInfo,
  EgressHandlerListResponse,
  ConfigureEgressHandlerRequest,
  UpdateEgressHandlerRequest,
  WorkspaceProvider,
  WorkspaceProviderListResponse,
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

export interface WorkspaceResponse {
  id: string;
  slug: string;
  name: string;
  description?: string | null;
  role: string;
  defaultModelId?: string | null;
}

export interface CurrentUserResponse {
  user: {
    id: string;
    email: string;
    displayName?: string;
    createdAt: number;
  };
  workspaces: Array<{
    id: string;
    slug: string;
    name: string;
    description?: string | null;
    role?: string;
  }>;
  currentWorkspace: WorkspaceResponse;
}

interface DeleteEgressHandlerResponse {
  ok: boolean;
  egressHandlerId: string;
}

interface CreateWorkspaceProviderRequest {
  provider: string;
  providerDisplayName?: string;
  secrets?: Record<string, string>;
  config?: Record<string, unknown>;
  defaultModelName?: string;
  createDefaultModel?: boolean;
  modelDisplayName?: string;
  modelConfig?: Record<string, unknown>;
  setAsDefault?: boolean;
}

interface CreateWorkspaceProviderResponse {
  provider: WorkspaceProvider;
  model?: Model;
  defaultModelId?: string;
}

interface DeleteWorkspaceProviderResponse {
  ok: boolean;
  providerId: string;
  deletedModelIds: string[];
  clearedDefaultModelId?: string;
}

const SESSION_EVENT_PAGE_SIZE = 100;
const FAST_POLL_INTERVAL_MS = 50;
const FAST_POLL_WINDOW_MS = 1500;
type SessionStreamTransport = "auto" | "ws" | "sse" | "poll";
type SessionStreamUpdate = { session: SessionResponse; newEvents: SessionEvent[]; complete: boolean };
type SessionWebSocketMessage =
  | { type: "session"; session: SessionResponse }
  | { type: "heartbeat" }
  | { type: "error"; error?: string; message?: string };

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname.endsWith(".localhost");
}

export class AgentClient {
  private url: string;
  private token: string;
  private workspace?: string;
  private ws?: WebSocket;
  private currentSessionId: string | null = null;

  constructor(url: string, token: string, workspace?: string) {
    // Require HTTPS for security, while allowing local Wrangler development.
    const urlObj = new URL(url);
    if (urlObj.protocol !== "https:" && !(urlObj.protocol === "http:" && isLoopbackHost(urlObj.hostname))) {
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

  private buildWebSocketUrl(path: string): string {
    return `${this.url.replace(/^https:/, "wss:").replace(/^http:/, "ws:")}${path}`;
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

  async stopSession(sessionId: string): Promise<{
    ok: boolean;
    sessionId: string;
    status: string;
    stopped: boolean;
    stoppedToolCallIds?: string[];
    toolStopErrors?: string[];
  }> {
    return this.requestJson<{
      ok: boolean;
      sessionId: string;
      status: string;
      stopped: boolean;
      stoppedToolCallIds?: string[];
      toolStopErrors?: string[];
    }>(
      `/v1/session/${sessionId}/stop`,
      { method: "POST" }
    );
  }

  async abortSession(sessionId: string): Promise<{ ok: boolean; sessionId: string; status: string; aborted: boolean }> {
    return this.requestJson<{ ok: boolean; sessionId: string; status: string; aborted: boolean }>(
      `/v1/session/${sessionId}/abort`,
      { method: "POST" }
    );
  }

  async killSession(sessionId: string): Promise<KillSessionResponse> {
    return this.requestJson<KillSessionResponse>(
      `/v1/session/${sessionId}/kill`,
      { method: "POST" }
    );
  }

  async deleteSession(sessionId: string): Promise<DeleteSessionResponse> {
    return this.requestJson<DeleteSessionResponse>(
      `/v1/session/${sessionId}`,
      { method: "DELETE" }
    );
  }

  async deleteSessions(): Promise<DeleteSessionsResponse> {
    return this.requestJson<DeleteSessionsResponse>(
      "/v1/sessions",
      { method: "DELETE" }
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

    if (transport === "auto" || transport === "ws") {
      let streamed = false;
      try {
        for await (const update of this.streamSessionEventsWebSocket(sessionId, signal, options)) {
          streamed = true;
          yield update;
        }
        return;
      } catch (error) {
        if (transport === "ws" || streamed || signal?.aborted) throw error;
        if (options.debug) {
          console.log(`[streamSession] WebSocket unavailable, falling back to SSE: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }

    if (transport === "auto" || transport === "sse") {
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

  private async *streamSessionEventsWebSocket(
    sessionId: string,
    signal?: AbortSignal,
    options: { initialCursor?: string; debug?: boolean; pollIntervalMs?: number; maxPolls?: number } = {},
  ): AsyncGenerator<SessionStreamUpdate> {
    const query = new URLSearchParams();
    if (options.initialCursor) query.set("since", options.initialCursor);
    query.set("includeMessages", "auto");

    const path = `/v1/session/${sessionId}/events/ws?${query.toString()}`;
    const wsUrl = this.buildWebSocketUrl(path);

    if (!wsUrl.startsWith("wss://")) {
      throw new Error(`Insecure WebSocket URL: ${wsUrl}. WSS (secure WebSocket) is required.`);
    }

    const ws = await this.openWebSocket(wsUrl, signal);
    let lastSession: SessionResponse | undefined;

    try {
      for await (const raw of iterateWebSocketMessages(ws, signal)) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

        const parsed = safeJsonParse<SessionWebSocketMessage>(webSocketDataToString(raw));
        if (!parsed) continue;
        if (parsed.type === "heartbeat") continue;
        if (parsed.type === "error") {
          throw new Error(parsed.error ?? parsed.message ?? "Session WebSocket stream failed");
        }
        if (parsed.type !== "session") continue;

        const session = parsed.session;
        lastSession = session;
        const newEvents = session.events;
        const complete = isSessionStreamComplete(session);

        if (options.debug) {
          console.log(`[streamSession] ws status=${session.status} events=${newEvents.length} complete=${complete} cursor=${session.nextEventCursor}`);
        }

        yield { session, newEvents, complete };

        if (complete) {
          if (options.debug) {
            console.log(`[streamSession] WebSocket complete - status=${session.status}`);
          }
          return;
        }
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      if (!isWebSocketDisconnectError(error)) throw error;

      if (lastSession && isSessionStreamComplete(lastSession)) {
        if (options.debug) {
          console.log(`[streamSession] WebSocket closed after completion - status=${lastSession.status}`);
        }
        return;
      }

      if (lastSession) {
        if (options.debug) {
          console.log(`[streamSession] WebSocket disconnected, resuming with polling from cursor=${lastSession.nextEventCursor}`);
        }
        yield* this.pollSession(sessionId, signal, {
          initialCursor: lastSession.nextEventCursor,
          pollIntervalMs: options.pollIntervalMs,
          maxPolls: options.maxPolls,
          debug: options.debug,
        });
        return;
      }

      throw error;
    } finally {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    }

    if (lastSession) {
      if (options.debug) {
        console.log(`[streamSession] WebSocket ended, resuming with polling from cursor=${lastSession.nextEventCursor}`);
      }
      yield* this.pollSession(sessionId, signal, {
        initialCursor: lastSession.nextEventCursor,
        pollIntervalMs: options.pollIntervalMs,
        maxPolls: options.maxPolls,
        debug: options.debug,
      });
      return;
    }

    throw new Error(`Session ${sessionId} WebSocket stream ended before completion`);
  }

  private openWebSocket(wsUrl: string, signal?: AbortSignal): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl, {
        headers: this.getHeaders(),
      });

      const cleanup = () => {
        ws.off("open", onOpen);
        ws.off("error", onError);
        signal?.removeEventListener("abort", onAbort);
      };
      const onOpen = () => {
        cleanup();
        resolve(ws);
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const onAbort = () => {
        cleanup();
        ws.close();
        reject(new DOMException("Aborted", "AbortError"));
      };

      ws.once("open", onOpen);
      ws.once("error", onError);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private async *pollSession(
    sessionId: string,
    signal?: AbortSignal,
    options: { pollIntervalMs?: number; maxPolls?: number; initialCursor?: string; debug?: boolean } = {},
  ): AsyncGenerator<SessionStreamUpdate> {
    const pollIntervalMs = options.pollIntervalMs ?? 250;
    const maxPolls = options.maxPolls ?? 10000;
    const startedAt = Date.now();
    let cursor: string | undefined = options.initialCursor;

    for (let poll = 0; poll < maxPolls; poll++) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      const session = await this.getSession(sessionId, cursor, { includeMessages: "auto" });
      
      const newEvents = session.events;
      const complete = isSessionStreamComplete(session);
      
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
      
      const elapsed = Date.now() - startedAt;
      const delayMs = elapsed < FAST_POLL_WINDOW_MS
        ? Math.min(pollIntervalMs, FAST_POLL_INTERVAL_MS)
        : pollIntervalMs;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
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
      const complete = isSessionStreamComplete(session);

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
    modelId?: string;
  }): Promise<CreateSessionResponse> {
    return this.createSession(input);
  }

  async listTools(): Promise<ToolInfo[]> {
    const { tools } = await this.requestJson<{ tools: ToolInfo[] }>("/v1/tools");
    return tools || [];
  }

  // WebSocket for streaming responses
  async connectWebSocket(): Promise<WebSocket> {
    const wsUrl = this.buildWebSocketUrl("/ws");
    
    // Ensure we're using secure WebSocket, while allowing local Wrangler development.
    const parsed = new URL(wsUrl);
    if (parsed.protocol !== "wss:" && !(parsed.protocol === "ws:" && isLoopbackHost(parsed.hostname))) {
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

  async getCurrentUser(): Promise<CurrentUserResponse> {
    return this.requestJson<CurrentUserResponse>("/v1/users/me");
  }

  async getWorkspace(): Promise<WorkspaceResponse> {
    return this.requestJson<WorkspaceResponse>("/v1/workspace");
  }

  async listProviders(): Promise<ProviderInfo[]> {
    const data = await this.requestJson<ProviderListResponse>("/v1/providers");
    return data.providers || [];
  }

  async listConfiguredProviders(): Promise<WorkspaceProvider[]> {
    const data = await this.requestJson<WorkspaceProviderListResponse>("/v1/providers/configured");
    return data.providers || [];
  }

  async createProvider(input: CreateWorkspaceProviderRequest): Promise<CreateWorkspaceProviderResponse> {
    return this.requestJson<CreateWorkspaceProviderResponse>("/v1/providers", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async deleteProvider(id: string): Promise<DeleteWorkspaceProviderResponse> {
    return this.requestJson<DeleteWorkspaceProviderResponse>(
      `/v1/providers/${encodeURIComponent(id)}`,
      { method: "DELETE" }
    );
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

  // Model API
  async listModels(): Promise<ModelListResponse> {
    return this.requestJson<ModelListResponse>("/v1/models");
  }

  async createModel(input: CreateModelRequest): Promise<Model> {
    const data = await this.requestJson<{ model: Model }>("/v1/models", {
      method: "POST",
      body: JSON.stringify(input),
    });
    return data.model;
  }

  async updateModel(
    id: string,
    input: UpdateModelRequest
  ): Promise<Model> {
    const data = await this.requestJson<{ model: Model }>(
      `/v1/models/${id}`,
      {
        method: "PATCH",
        body: JSON.stringify(input),
      }
    );
    return data.model;
  }

  async deleteModel(id: string): Promise<{ ok: boolean }> {
    return this.requestJson<{ ok: boolean }>(`/v1/models/${id}`, {
      method: "DELETE",
    });
  }

  async setDefaultModel(id: string | null): Promise<{
    ok: boolean;
    defaultModelId?: string;
  }> {
    return this.requestJson<{ ok: boolean; defaultModelId?: string }>(
      "/v1/workspace/default-model",
      {
        method: "PUT",
        body: JSON.stringify({ modelId: id }),
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

function isSessionStreamComplete(session: SessionResponse): boolean {
  const sessionComplete = session.status === "idle" ||
    session.status === "error" ||
    session.status === "closed" ||
    session.status === "expired";
  const mayHaveMoreEvents = sessionComplete && session.events.length >= SESSION_EVENT_PAGE_SIZE;
  return sessionComplete && !mayHaveMoreEvents;
}

function isWebSocketDisconnectError(error: unknown): boolean {
  if (!error) return false;
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return normalized.includes("network connection lost") ||
    normalized.includes("socket is closed") ||
    normalized.includes("websocket is not open") ||
    normalized.includes("websocket was closed") ||
    normalized.includes("connection closed");
}

async function* iterateWebSocketMessages(ws: WebSocket, signal?: AbortSignal): AsyncGenerator<unknown> {
  const queue: unknown[] = [];
  let done = false;
  let error: Error | undefined;
  let wake: (() => void) | undefined;

  const notify = () => {
    wake?.();
    wake = undefined;
  };
  const onMessage = (data: unknown) => {
    queue.push(data);
    notify();
  };
  const onClose = () => {
    done = true;
    notify();
  };
  const onError = (err: Error) => {
    error = err;
    done = true;
    notify();
  };
  const onAbort = () => {
    done = true;
    ws.close();
    notify();
  };

  ws.on("message", onMessage);
  ws.on("close", onClose);
  ws.on("error", onError);
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    while (true) {
      if (queue.length > 0) {
        yield queue.shift();
        continue;
      }
      if (error) throw error;
      if (done) return;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  } finally {
    ws.off("message", onMessage);
    ws.off("close", onClose);
    ws.off("error", onError);
    signal?.removeEventListener("abort", onAbort);
  }
}

function webSocketDataToString(value: unknown): string {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  if (value instanceof ArrayBuffer) return Buffer.from(value).toString("utf8");
  if (Array.isArray(value)) return Buffer.concat(value as Uint8Array[]).toString("utf8");
  return String(value);
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

function isRawQueryError(message: string): boolean {
  return message.startsWith("Failed query:") || message.includes("\nparams:");
}

// Format API errors with rich context for display
export function formatApiError(status: number, errorData: ApiError): string {
  const baseMessage = errorData.error || "Unknown error";

  if (status >= 500 && isRawQueryError(baseMessage)) {
    return "Server database query failed. Check server logs for query details.";
  }
  
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
