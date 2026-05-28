import { DurableObject } from "cloudflare:workers";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Env, SessionMetadataState,} from "./internal-types/index.js";
import type { ChatRequest } from "./types.js";
import type { SessionInputEvent } from "./data/index.js";
import { getDataLayer } from "./data/index.js";
import { logger } from "./logger.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function messageToText(message: AgentMessage): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((part): part is { type: "text"; text: string } =>
        typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text"
      )
      .map((part) => part.text)
      .join("");
  }
  return "";
}

export class ClawflareWebSocketSession extends DurableObject<Env> {
  private websockets: WebSocket[] = [];

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // WebSocket upgrade
    if (request.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      this.websockets.push(server);
      this.handleWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    // REST endpoints
    if (path === "/send" && request.method === "POST") {
      return this.handleSend(request);
    }

    return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
  }

  private handleWebSocket(ws: WebSocket): void {
    ws.accept();

    ws.addEventListener("message", async (event) => {
      try {
        const data = JSON.parse(event.data as string) as ChatRequest;

        if (!data.content) {
          ws.send(JSON.stringify({
            type: "error",
            message: "Invalid request. content is required"
          }));
          return;
        }

        await this.startWorkflowAndStream(ws, data);

      } catch (error) {
        logger.error("WebSocket message handling failed", error, {
          handler: "ClawflareWebSocketSession.handleWebSocket",
        });
        ws.send(JSON.stringify({
          type: "error",
          message: error instanceof Error ? error.message : String(error)
        }));
      }
    });

    ws.addEventListener("close", () => {
      this.websockets = this.websockets.filter(w => w !== ws);
    });
  }

  private async startWorkflowAndStream(ws: WebSocket, data: ChatRequest): Promise<void> {
    if (!data.content) {
      ws.send(JSON.stringify({ type: "error", content: "Invalid request. type='prompt' and content required" }));
      return;
    }

    const promptContent = data.content;
    const sessionId = data.sessionId || crypto.randomUUID();
    let workflowId: string;
    const dataLayer = getDataLayer(this.env);
    const existingSession = data.sessionId ? await dataLayer.sessions.findById(data.sessionId) : null;

    if (existingSession) {
      if (existingSession.status === "closed" || existingSession.status === "expired") {
        ws.send(JSON.stringify({ type: "error", content: "Session closed. Create a new session to continue." }));
        return;
      }

      workflowId = existingSession.workflowId;
      existingSession.status = "processing";
      existingSession.updatedAt = Date.now();
      await dataLayer.sessions.save(existingSession);
    } else {
      workflowId = crypto.randomUUID();
      // Phase 6: workspace-scoped sessions
      const workspaceId = "default-workspace"; // Until full auth is in place
      const initialState: SessionMetadataState = {
        id: sessionId,
        workspaceId,
        workflowId,
        status: "processing",
        nextEventCursor: "0",
        updatedAt: Date.now(),
        maxQueueSize: 100,
        idleTimeout: "7 days",
      };
      await dataLayer.sessions.save(initialState);
    }

    const enqueueResult = await dataLayer.inputQueue.enqueue(sessionId, {
      type: "prompt",
      content: promptContent,
      maxTurns: data.maxTurns,
    } as SessionInputEvent);

    if (!enqueueResult.ok) {
      ws.send(JSON.stringify({ type: "error", content: enqueueResult.error || "Queue full" }));
      return;
    }

    if (!existingSession) {
      await this.env.AGENT_WORKFLOW.create({
        id: workflowId,
        params: { sessionId },
      });
    }

    const workflowInstance = await this.env.AGENT_WORKFLOW.get(workflowId);
    await workflowInstance.sendEvent({
      type: "session-input",
      payload: { type: "wake" },
    });

    ws.send(JSON.stringify({
      type: "session_started",
      sessionId,
    }));

    const message = await this.waitForAssistantMessage(sessionId);
    if (!message) {
      ws.send(JSON.stringify({ type: "error", content: "Timed out waiting for workflow response" }));
      return;
    }

    ws.send(JSON.stringify({
      type: "message",
      sessionId,
      content: messageToText(message),
      message,
    }));
  }

  private async waitForAssistantMessage(sessionId: string): Promise<AgentMessage | null> {
    const dataLayer = getDataLayer(this.env);

    for (let i = 0; i < 120; i++) {
      const [session, workflowSession] = await Promise.all([
        dataLayer.sessions.findById(sessionId),
        dataLayer.runtime.getWorkflowSession(sessionId) as Promise<{ messages?: AgentMessage[] } | null>,
      ]);

      const assistantMessage = workflowSession?.messages
        ?.slice()
        .reverse()
        .find((message) => message.role === "assistant");

      if (assistantMessage && session?.status === "idle") {
        return assistantMessage;
      }

      if (session?.status === "error" || session?.status === "closed" || session?.status === "expired") {
        return assistantMessage ?? null;
      }

      await delay(500);
    }

    return null;
  }

  private async handleSend(request: Request): Promise<Response> {
    const data = await request.json<ChatRequest>();

    // Broadcast to all connected websockets
    for (const ws of this.websockets) {
      ws.send(JSON.stringify(data));
    }

    return new Response(JSON.stringify({ ok: true, delivered: this.websockets.length }));
  }
}
