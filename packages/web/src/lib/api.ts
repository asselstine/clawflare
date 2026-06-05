import type {
  ChatRequest,
  ChatSubmittedResponse,
  ConfigureEgressHandlerRequest,
  ContainerSummary,
  CreateModelRequest,
  CreateSessionRequest,
  CreateSessionResponse,
  DeleteSessionResponse,
  DeleteSessionsResponse,
  EgressHandlerInfo,
  EgressHandlerListResponse,
  KillSessionResponse,
  Model,
  ModelListResponse,
  ProviderInfo,
  ProviderListResponse,
  ProviderModelInfo,
  ProviderModelsResponse,
  SessionListResponse,
  SessionResponse,
  UpdateEgressHandlerRequest,
  UpdateModelRequest,
  WorkspaceProvider,
  WorkspaceProviderListResponse,
} from "@clawflare/types";
import { isSessionComplete } from "./format";

interface StreamUpdate {
  session: SessionResponse;
  newEvents: SessionResponse["events"];
  complete: boolean;
}

const SESSION_EVENT_PAGE_SIZE = 100;

export interface DeviceStartResponse {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  authorizationUrl?: string;
  expiresIn: number;
  interval: number;
}

export type DevicePollResponse =
  | { status: "pending" }
  | { status: "denied"; message?: string }
  | { status: "expired"; message?: string }
  | {
      status: "complete";
      accessToken?: string;
      user?: {
        id: string;
        email?: string;
        displayName?: string;
      };
    };

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
  currentWorkspace: {
    id: string;
    slug: string;
    name: string;
    description?: string | null;
    role: string;
    defaultModelId?: string | null;
  };
}

export interface CreateWorkspaceProviderRequest {
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

export interface CreateWorkspaceProviderResponse {
  provider: WorkspaceProvider;
  model?: Model;
  defaultModelId?: string;
}

export interface DeleteWorkspaceProviderResponse {
  ok: boolean;
  providerId: string;
  deletedModelIds: string[];
  clearedDefaultModelId?: string;
}

interface RequestOptions extends RequestInit {
  skipJsonContentType?: boolean;
  skipAuth?: boolean;
}

export class ApiError extends Error {
  readonly status: number;
  readonly statusText: string;

  constructor(response: Response, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = response.status;
    this.statusText = response.statusText;
  }
}

export class ClawflareApiClient {
  readonly baseUrl: string;
  readonly token: string;

  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.token = token;
  }

  async getCurrentUser(): Promise<CurrentUserResponse> {
    return this.requestJson<CurrentUserResponse>("/v1/users/me");
  }

  async startDeviceAuth(provider: "github" = "github", returnUrl?: string): Promise<DeviceStartResponse> {
    return this.requestJson<DeviceStartResponse>("/v1/auth/device/start", {
      method: "POST",
      body: JSON.stringify({
        clientName: "Clawflare Web",
        provider,
        returnUrl,
      }),
      skipAuth: true,
    });
  }

  async pollDeviceAuth(deviceCode: string): Promise<DevicePollResponse> {
    return this.requestJson<DevicePollResponse>("/v1/auth/device/poll", {
      method: "POST",
      body: JSON.stringify({ deviceCode }),
      skipAuth: true,
    });
  }

  async createSession(input: CreateSessionRequest = {}): Promise<CreateSessionResponse> {
    return this.requestJson<CreateSessionResponse>("/v1/session", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async submitChat(input: ChatRequest): Promise<ChatSubmittedResponse> {
    return this.requestJson<ChatSubmittedResponse>("/v1/chat", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async getSession(
    sessionId: string,
    cursor?: string,
    includeMessages: boolean | "auto" = "auto",
    options: { eventWindow?: "tail" | "before"; eventLimit?: number; before?: string; includePromptHistory?: boolean } = {},
  ): Promise<SessionResponse> {
    const params = new URLSearchParams();
    if (cursor) params.set("since", cursor);
    params.set("includeMessages", includeMessages === "auto" ? "auto" : includeMessages ? "1" : "0");
    if (options.eventWindow) params.set("eventWindow", options.eventWindow);
    if (options.eventLimit !== undefined) params.set("eventLimit", String(options.eventLimit));
    if (options.before) params.set("before", options.before);
    if (options.includePromptHistory) params.set("includePromptHistory", "1");
    return this.requestJson<SessionResponse>(`/v1/session/${encodeURIComponent(sessionId)}?${params.toString()}`);
  }

  async listSessions(options: { status?: string; sessionId?: string; limit?: number; offset?: number } = {}): Promise<SessionListResponse> {
    const params = new URLSearchParams();
    if (options.status && options.status !== "all") params.set("status", options.status);
    if (options.sessionId) params.set("sessionId", options.sessionId);
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    if (options.offset !== undefined) params.set("offset", String(options.offset));
    return this.requestJson<SessionListResponse>(`/v1/sessions${params.size ? `?${params.toString()}` : ""}`);
  }

  async renameSession(sessionId: string, name: string): Promise<{ ok: boolean; sessionId: string; name: string }> {
    return this.requestJson(`/v1/session/${encodeURIComponent(sessionId)}/name`, {
      method: "POST",
      body: JSON.stringify({ name }),
    });
  }

  async renameContainer(containerId: string, name: string): Promise<{ ok: boolean; id: string; name: string; container: ContainerSummary }> {
    return this.requestJson(`/v1/containers/${encodeURIComponent(containerId)}/name`, {
      method: "POST",
      body: JSON.stringify({ name }),
    });
  }

  async closeSession(sessionId: string): Promise<{ ok: boolean; sessionId: string; status: string }> {
    return this.requestJson(`/v1/session/${encodeURIComponent(sessionId)}/close`, { method: "POST" });
  }

  async abortSession(sessionId: string): Promise<{ ok: boolean; sessionId: string; status: string; aborted: boolean }> {
    return this.requestJson(`/v1/session/${encodeURIComponent(sessionId)}/abort`, { method: "POST" });
  }

  async killSession(sessionId: string): Promise<KillSessionResponse> {
    return this.requestJson<KillSessionResponse>(`/v1/session/${encodeURIComponent(sessionId)}/kill`, { method: "POST" });
  }

  async deleteSession(sessionId: string): Promise<DeleteSessionResponse> {
    return this.requestJson<DeleteSessionResponse>(`/v1/session/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
  }

  async deleteSessions(): Promise<DeleteSessionsResponse> {
    return this.requestJson<DeleteSessionsResponse>("/v1/sessions", { method: "DELETE" });
  }

  async listTools(): Promise<Array<{ name: string; description: string; parameters: unknown }>> {
    const data = await this.requestJson<{ tools: Array<{ name: string; description: string; parameters: unknown }> }>("/v1/tools");
    return data.tools ?? [];
  }

  async invokeTool<TDetails = unknown>(
    sessionId: string,
    name: string,
    input: Record<string, unknown>,
  ): Promise<{ tool: string; result: { content?: Array<{ type: string; text?: string }>; details?: TDetails } }> {
    return this.requestJson(`/v1/tools/${encodeURIComponent(name)}`, {
      method: "POST",
      body: JSON.stringify({ sessionId, input }),
    });
  }

  async listProviders(): Promise<ProviderInfo[]> {
    const data = await this.requestJson<ProviderListResponse>("/v1/providers");
    return data.providers ?? [];
  }

  async listProviderModels(providerId: string): Promise<ProviderModelInfo[]> {
    const data = await this.requestJson<ProviderModelsResponse>(`/v1/providers/${encodeURIComponent(providerId)}/models`);
    return data.models ?? [];
  }

  async listConfiguredProviders(): Promise<WorkspaceProvider[]> {
    const data = await this.requestJson<WorkspaceProviderListResponse>("/v1/providers/configured");
    return data.providers ?? [];
  }

  async createProvider(input: CreateWorkspaceProviderRequest): Promise<CreateWorkspaceProviderResponse> {
    return this.requestJson<CreateWorkspaceProviderResponse>("/v1/providers", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async deleteProvider(id: string): Promise<DeleteWorkspaceProviderResponse> {
    return this.requestJson<DeleteWorkspaceProviderResponse>(`/v1/providers/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

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

  async updateModel(id: string, input: UpdateModelRequest): Promise<Model> {
    const data = await this.requestJson<{ model: Model }>(`/v1/models/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    });
    return data.model;
  }

  async deleteModel(id: string): Promise<{ ok: boolean }> {
    return this.requestJson<{ ok: boolean }>(`/v1/models/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  async setDefaultModel(modelId: string | null): Promise<{ ok: boolean; defaultModelId?: string }> {
    return this.requestJson("/v1/workspace/default-model", {
      method: "PUT",
      body: JSON.stringify({ modelId }),
    });
  }

  async listAvailableEgressHandlers(): Promise<EgressHandlerInfo[]> {
    const data = await this.requestJson<EgressHandlerListResponse>("/v1/egress-handlers/available");
    return data.egressHandlers ?? [];
  }

  async listEgressHandlers(options: { enabledOnly?: boolean } = {}): Promise<EgressHandlerInfo[]> {
    const params = new URLSearchParams();
    if (options.enabledOnly === false) params.set("enabledOnly", "false");
    const data = await this.requestJson<EgressHandlerListResponse>(`/v1/egress-handlers${params.size ? `?${params.toString()}` : ""}`);
    return data.egressHandlers ?? [];
  }

  async configureEgressHandler(input: ConfigureEgressHandlerRequest): Promise<EgressHandlerInfo> {
    const data = await this.requestJson<{ egressHandler: EgressHandlerInfo }>("/v1/egress-handlers", {
      method: "POST",
      body: JSON.stringify(input),
    });
    return data.egressHandler;
  }

  async updateEgressHandler(egressHandlerId: string, input: UpdateEgressHandlerRequest): Promise<EgressHandlerInfo> {
    const data = await this.requestJson<{ egressHandler: EgressHandlerInfo }>(`/v1/egress-handlers/${encodeURIComponent(egressHandlerId)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    });
    return data.egressHandler;
  }

  async deleteEgressHandler(egressHandlerId: string): Promise<{ ok: boolean; egressHandlerId: string }> {
    return this.requestJson(`/v1/egress-handlers/${encodeURIComponent(egressHandlerId)}`, { method: "DELETE" });
  }

  async cfDebug(sessionId?: string, key?: string): Promise<unknown> {
    const params = new URLSearchParams();
    if (sessionId) params.set("sessionId", sessionId);
    if (key) params.set("key", key);
    return this.requestJson(`/v1/cf_debug${params.size ? `?${params.toString()}` : ""}`);
  }

  async *streamSession(sessionId: string, initialCursor?: string, signal?: AbortSignal): AsyncGenerator<StreamUpdate> {
    try {
      yield* this.streamSessionSse(sessionId, initialCursor, signal);
      return;
    } catch (error) {
      if (signal?.aborted) throw error;
    }

    yield* this.pollSession(sessionId, initialCursor, signal);
  }

  private async *streamSessionSse(sessionId: string, initialCursor?: string, signal?: AbortSignal): AsyncGenerator<StreamUpdate> {
    const params = new URLSearchParams({ includeMessages: "auto", includePromptHistory: "1" });
    if (initialCursor) params.set("since", initialCursor);
    const response = await this.request(`/v1/session/${encodeURIComponent(sessionId)}/events?${params.toString()}`, {
      headers: { Accept: "text/event-stream" },
      signal,
      skipJsonContentType: true,
    });

    if (!response.ok) throw new ApiError(response, await responseErrorMessage(response));
    if (!response.body) throw new Error("Event stream response has no body");

    let sawActivity = false;
    for await (const event of parseServerSentEvents(response.body)) {
      if (event.event === "heartbeat") continue;
      if (event.event === "error") throw new Error(event.data || "Session stream failed");
      if (event.event && event.event !== "session") continue;

      const session = safeJsonParse<SessionResponse>(event.data);
      if (!session) continue;
      sawActivity = sawActivity || session.status === "processing" || session.events.length > 0;
      const complete = isStreamComplete(session, sawActivity);
      yield {
        session,
        newEvents: session.events,
        complete,
      };
      if (complete) return;
    }

    throw new Error("Session event stream closed before completion");
  }

  private async *pollSession(sessionId: string, initialCursor?: string, signal?: AbortSignal): AsyncGenerator<StreamUpdate> {
    let cursor = initialCursor;
    let sawActivity = false;
    for (let i = 0; i < 10_000; i++) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const session = await this.getSession(sessionId, cursor, "auto", { includePromptHistory: true });
      cursor = session.nextEventCursor;
      sawActivity = sawActivity || session.status === "processing" || session.events.length > 0;
      const complete = isStreamComplete(session, sawActivity);
      yield { session, newEvents: session.events, complete };
      if (complete) return;
      await new Promise((resolve) => setTimeout(resolve, i < 6 ? 100 : 350));
    }
    throw new Error(`Session ${sessionId} did not complete before polling timed out`);
  }

  private async requestJson<T>(path: string, init: RequestOptions = {}): Promise<T> {
    const response = await this.request(path, init);
    if (!response.ok) throw new ApiError(response, await responseErrorMessage(response));
    const text = await response.text();
    if (!text || text === "undefined") {
      throw new Error(`Expected JSON from ${path}, received ${text ? "invalid" : "empty"} response`);
    }
    const parsed = safeJsonParse<T>(text);
    if (parsed === null) {
      throw new Error(`Expected JSON from ${path}, received invalid response`);
    }
    return parsed;
  }

  private request(path: string, init: RequestOptions = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (!init.skipAuth && this.token) headers.set("Authorization", `Bearer ${this.token}`);
    if (!init.skipJsonContentType && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    return fetch(`${this.baseUrl}${path}`, { ...init, headers });
  }
}

function isStreamComplete(session: SessionResponse, sawActivity: boolean): boolean {
  if (!isSessionComplete(session.status)) return false;
  if (session.events.length >= SESSION_EVENT_PAGE_SIZE) return false;
  return sawActivity || session.status !== "idle";
}

interface ParsedSse {
  event?: string;
  data: string;
}

async function responseErrorMessage(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  if (!text) return `${response.status} ${response.statusText}`.trim();
  const parsed = safeJsonParse<{ error?: string; hint?: string }>(text);
  return [parsed?.error ?? text, parsed?.hint].filter(Boolean).join("\n");
}

function safeJsonParse<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

async function* parseServerSentEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<ParsedSse> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let separator = findSeparator(buffer);
      while (separator !== -1) {
        const raw = buffer.slice(0, separator);
        buffer = buffer.slice(separator + separatorLength(buffer, separator));
        const parsed = parseSse(raw);
        if (parsed) yield parsed;
        separator = findSeparator(buffer);
      }
    }
    buffer += decoder.decode();
    const parsed = parseSse(buffer);
    if (parsed) yield parsed;
  } finally {
    reader.releaseLock();
  }
}

function parseSse(raw: string): ParsedSse | null {
  const data: string[] = [];
  let event: string | undefined;
  for (const line of raw.split(/\r?\n|\r/)) {
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

function findSeparator(value: string): number {
  return [value.indexOf("\n\n"), value.indexOf("\r\r"), value.indexOf("\r\n\r\n")]
    .filter((index) => index !== -1)
    .sort((a, b) => a - b)[0] ?? -1;
}

function separatorLength(value: string, index: number): number {
  return value.startsWith("\r\n\r\n", index) ? 4 : 2;
}
