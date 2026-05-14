/**
 * Agent Client - Communicates with the Clawflare harness
 */

import WebSocket from "ws";

export interface ChatRequest {
  type: "prompt" | "steer" | "fork" | "new_context";
  content?: string;
  sessionId?: string;
  maxTurns?: number;
}

export interface ChatUsage {
  input: number;
  output: number;
  totalTokens: number;
}

export interface ChatResponse {
  type: "message" | "error" | "context_update";
  content: string;
  sessionId?: string;
  usage?: ChatUsage;
}

export interface WorkflowStartedResponse {
  type: "workflow_started";
  id: string;
  workflowId: string;
  instanceId: string;
  sessionId: string;
  status: "running";
  pollUrl: string;
}

export interface WorkflowProgressEvent {
  timestamp: number;
  sequence: number;
  type: "workflow" | "agent" | "turn" | "tool" | "message" | "error";
  summary: string;
  event?: unknown;
}

export interface WorkflowStatusResponse {
  status: "running" | "success" | "errored" | "paused";
  currentStep?: string;
  response?: ChatResponse;
  state?: {
    id: string;
    sessionId: string;
    turnCount: number;
    maxTurns: number;
    status: "running" | "idle" | "error" | "awaiting_input";
    progress?: WorkflowProgressEvent[];
    errorMessage?: string;
  };
  session?: unknown;
}

export interface ContextInfo {
  id: string;
  parentId?: string;
  messages: AgentMessage[];
  createdAt: number;
}

export interface AgentMessage {
  role: "user" | "assistant" | "tool";
  content: string | Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
  timestamp: number;
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
  private defaultTimeout = 10000; // 10 second timeout

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

  // Helper to add timeout to fetch - DEPRECATED: Use direct fetch instead
  private async fetchWithTimeout(
    input: string | URL,
    init?: RequestInit,
    _timeoutMs?: number
  ): Promise<Response> {
    return fetch(input, init);
  }

  // HTTP methods
  async startChatWorkflow(request: ChatRequest, signal?: AbortSignal): Promise<WorkflowStartedResponse> {
    const requestWithContext: ChatRequest = {
      ...request,
      sessionId: request.sessionId ?? this.currentContextId ?? undefined,
    };

    const response = await fetch(
      `${this.url}/v1/chat`,
      {
        method: "POST",
        headers: this.getHeaders(),
        body: JSON.stringify(requestWithContext),
        signal,
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Chat failed: ${response.status} - ${error}`);
    }

    const data = await response.json() as WorkflowStartedResponse;
    if (data.sessionId) this.currentContextId = data.sessionId;
    return data;
  }

  async getWorkflowStatus(workflowId: string, signal?: AbortSignal): Promise<WorkflowStatusResponse> {
    const response = await fetch(`${this.url}/v1/workflow/${workflowId}`, {
      method: "GET",
      headers: this.getHeaders(),
      signal,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Workflow status failed: ${response.status} - ${error}`);
    }

    return response.json() as Promise<WorkflowStatusResponse>;
  }

  async waitForWorkflow(
    workflow: WorkflowStartedResponse,
    signal?: AbortSignal,
    options: { pollIntervalMs?: number; maxPolls?: number; onStatus?: (status: WorkflowStatusResponse) => void } = {}
  ): Promise<ChatResponse> {
    const pollIntervalMs = options.pollIntervalMs ?? 1000;
    const maxPolls = options.maxPolls ?? 300;

    for (let poll = 0; poll < maxPolls; poll++) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));

      const status = await this.getWorkflowStatus(workflow.id, signal);
      options.onStatus?.(status);
      if (status.status === "running") continue;

      if (status.response) {
        if (status.response.sessionId) this.currentContextId = status.response.sessionId;
        return status.response;
      }

      return {
        type: "error",
        content: `Workflow ${workflow.id} finished without a response`,
        sessionId: workflow.sessionId,
      };
    }

    return {
      type: "error",
      content: `Workflow ${workflow.id} did not finish before polling timed out`,
      sessionId: workflow.sessionId,
    };
  }

  async chat(request: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
    const workflow = await this.startChatWorkflow(request, signal);
    return this.waitForWorkflow(workflow, signal);
  }

  async getContext(): Promise<ContextInfo> {
    const response = await fetch(
      `${this.url}/v1/context`,
      {
        method: "GET",
        headers: this.getHeaders(),
      }
    );

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      throw new Error(`Failed to get context: ${response.status} - ${errorText}`);
    }

    const data = await response.json() as ContextInfo;
    this.currentContextId = data.id;
    return data;
  }

  async createContext(parentId?: string): Promise<ContextInfo> {
    const response = await fetch(
      `${this.url}/v1/context`,
      {
        method: "POST",
        headers: this.getHeaders(),
        body: JSON.stringify({ parentId }),
      }
    );

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

  async steer(_message: string): Promise<void> {
    throw new Error("Steering is not supported for workflow-backed chat");
  }

  async listTools(): Promise<ToolInfo[]> {
    const response = await fetch(
      `${this.url}/v1/tools`,
      {
        method: "GET",
        headers: this.getHeaders(),
      }
    );

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

  // Get server info (provider, model, context window)
  async getServerInfo(): Promise<ServerInfo> {
    const response = await fetch(
      `${this.url}/v1/info`,
      {
        method: "GET",
        headers: this.getHeaders(),
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to get server info: ${response.status}`);
    }

    const data = await response.json() as ServerInfo;
    return data;
  }
}