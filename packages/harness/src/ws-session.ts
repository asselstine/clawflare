import { DurableObject } from "cloudflare:workers";
import type {
  Env,
  SessionInputEvent,
} from "./internal-types/index.js";
import type { ChatRequest } from "./types.js";

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

        if (data.type !== "prompt" || !data.content) {
          ws.send(JSON.stringify({
            type: "error",
            message: "Invalid request. type='prompt' and content required"
          }));
          return;
        }

        // Create session if needed
        const sessionId = data.sessionId || crypto.randomUUID();

        // Queue input and trigger workflow (simplified)
        const _inputEvent: SessionInputEvent = {
          type: "prompt",
          content: data.content,
          maxTurns: data.maxTurns,
        };
        // Use inputEvent to trigger workflow
        void _inputEvent;

        ws.send(JSON.stringify({
          type: "session_started",
          sessionId,
        }));

        // In a real implementation, this would trigger the workflow
        // and stream events back via the websocket

      } catch (error) {
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

  private async handleSend(request: Request): Promise<Response> {
    const data = await request.json<ChatRequest>();

    // Broadcast to all connected websockets
    for (const ws of this.websockets) {
      ws.send(JSON.stringify(data));
    }

    return new Response(JSON.stringify({ ok: true, delivered: this.websockets.length }));
  }
}
