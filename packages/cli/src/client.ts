/**
 * Agent Client - Communicates with the Clawflare harness
 */

import WebSocket from "ws";

export interface ChatRequest {
  type: "prompt" | "steer" | "fork" | "new_context";
  content?: string;
  contextId?: string;
}

export interface ChatResponse {
  type: "message" | "error" | "context_update";
  content: string;
  contextId?: string;
  usage?: {
    input: number;
    output: number;
    totalTokens: number;
  };
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
  async chat(request: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
    const response = await fetch(
      `${this.url}/v1/chat`,
      {
        method: "POST",
        headers: this.getHeaders(),
        body: JSON.stringify(request),
        signal: signal,
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Chat failed: ${response.status} - ${error}`);
    }

    const data = await response.json() as ChatResponse;
    if (data.contextId) {
      this.currentContextId = data.contextId;
    }
    return data;
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
    const response = await this.chat({ type: "fork", contextId: this.currentContextId || undefined });
    if (response.contextId) {
      this.currentContextId = response.contextId;
    }
    // Get the new context details
    return this.getContext();
  }

  async steer(message: string): Promise<void> {
    await this.chat({ type: "steer", content: message });
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