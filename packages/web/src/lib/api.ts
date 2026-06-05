import type {
  ChatRequest,
  ChatSubmittedResponse,
  ConfigureEgressHandlerRequest,
  CreateModelConnectionRequest,
  CreateSessionRequest,
  CreateSessionResponse,
  DeleteSessionResponse,
  DeleteSessionsResponse,
  EgressHandlerInfo,
  EgressHandlerListResponse,
  KillSessionResponse,
  ModelConnection,
  ModelConnectionListResponse,
  ProviderInfo,
  ProviderListResponse,
  ProviderModelInfo,
  ProviderModelsResponse,
  ServerInfo,
  SessionListResponse,
  SessionResponse,
  UpdateEgressHandlerRequest,
  UpdateModelConnectionRequest,
} from "@clawflare/types";
import { isSessionComplete } from "./format";

interface StreamUpdate {
  session: SessionResponse;
  newEvents: SessionResponse["events"];
  complete: boolean;
}

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

interface RequestOptions extends RequestInit {
  skipJsonContentType?: boolean;
  skipAuth?: boolean;
}

export class ClawflareApiClient {
  readonly baseUrl: string;
  readonly token: string;

  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.token = token;
  }

  async getInfo(): Promise<ServerInfo> {
    return this.requestJson<ServerInfo>("/v1/info");
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
    options: { eventWindow?: "tail"; eventLimit?: number } = {},
  ): Promise<SessionResponse> {
    const params = new URLSearchParams();
    if (cursor) params.set("since", cursor);
    params.set("includeMessages", includeMessages === "auto" ? "auto" : includeMessages ? "1" : "0");
    if (options.eventWindow) params.set("eventWindow", options.eventWindow);
    if (options.eventLimit !== undefined) params.set("eventLimit", String(options.eventLimit));
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

  async closeSession(sessionId: string): Promise<{ ok: boolean; sessionId: string; status: string }> {
    return this.requestJson(`/v1/session/${encodeURIComponent(sessionId)}/close`, { method: "POST" });
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

  async listProviders(): Promise<ProviderInfo[]> {
    const data = await this.requestJson<ProviderListResponse>("/v1/providers");
    return data.providers ?? [];
  }

  async listProviderModels(providerId: string): Promise<ProviderModelInfo[]> {
    const data = await this.requestJson<ProviderModelsResponse>(`/v1/providers/${encodeURIComponent(providerId)}/models`);
    return data.models ?? [];
  }

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

  async updateModelConnection(id: string, input: UpdateModelConnectionRequest): Promise<ModelConnection> {
    const data = await this.requestJson<{ modelConnection: ModelConnection }>(`/v1/model-connections/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    });
    return data.modelConnection;
  }

  async deleteModelConnection(id: string): Promise<{ ok: boolean }> {
    return this.requestJson<{ ok: boolean }>(`/v1/model-connections/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  async setDefaultModelConnection(modelConnectionId: string | null): Promise<{ ok: boolean; defaultModelConnectionId?: string }> {
    return this.requestJson("/v1/workspace/default-model-connection", {
      method: "PUT",
      body: JSON.stringify({ modelConnectionId }),
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
    const params = new URLSearchParams({ includeMessages: "auto" });
    if (initialCursor) params.set("since", initialCursor);
    const response = await this.request(`/v1/session/${encodeURIComponent(sessionId)}/events?${params.toString()}`, {
      headers: { Accept: "text/event-stream" },
      signal,
      skipJsonContentType: true,
    });

    if (!response.ok) throw new Error(await responseErrorMessage(response));
    if (!response.body) throw new Error("Event stream response has no body");

    for await (const event of parseServerSentEvents(response.body)) {
      if (event.event === "heartbeat") continue;
      if (event.event === "error") throw new Error(event.data || "Session stream failed");
      if (event.event && event.event !== "session") continue;

      const session = safeJsonParse<SessionResponse>(event.data);
      if (!session) continue;
      yield {
        session,
        newEvents: session.events,
        complete: isSessionComplete(session.status, session.events.length),
      };
      if (isSessionComplete(session.status, session.events.length)) return;
    }
  }

  private async *pollSession(sessionId: string, initialCursor?: string, signal?: AbortSignal): AsyncGenerator<StreamUpdate> {
    let cursor = initialCursor;
    for (let i = 0; i < 10_000; i++) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const session = await this.getSession(sessionId, cursor, "auto");
      cursor = session.nextEventCursor;
      const complete = isSessionComplete(session.status, session.events.length);
      yield { session, newEvents: session.events, complete };
      if (complete) return;
      await new Promise((resolve) => setTimeout(resolve, i < 6 ? 100 : 350));
    }
    throw new Error(`Session ${sessionId} did not complete before polling timed out`);
  }

  private async requestJson<T>(path: string, init: RequestOptions = {}): Promise<T> {
    const response = await this.request(path, init);
    if (!response.ok) throw new Error(await responseErrorMessage(response));
    return response.json() as Promise<T>;
  }

  private request(path: string, init: RequestOptions = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (!init.skipAuth && this.token) headers.set("Authorization", `Bearer ${this.token}`);
    if (!init.skipJsonContentType && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    return fetch(`${this.baseUrl}${path}`, { ...init, headers });
  }
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
