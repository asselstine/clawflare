import { DurableObject } from "cloudflare:workers";
import type { Env, ChatRequest } from "./types";
import { getWorkflowStatus, startAgentWorkflow } from "./workflow";

const POLL_INTERVAL_MS = 1000;
const MAX_POLLS = 300;

export class ClawflareWebSocketSession extends DurableObject<Env> {
  constructor(ctx: DurableObjectState<Env>, env: Env) {
    super(ctx, env);
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
    this.handleSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  private handleSocket(ws: WebSocket): void {
    ws.accept();

    ws.addEventListener("message", (event) => {
      void this.handleMessage(ws, event.data as string);
    });
  }

  private async handleMessage(ws: WebSocket, raw: string): Promise<void> {
    try {
      const data = JSON.parse(raw) as ChatRequest;

      if (data.type !== "prompt") {
        ws.send(JSON.stringify({
          type: "error",
          content: "WebSocket workflow sessions currently support prompt messages only",
        }));
        return;
      }

      const started = await startAgentWorkflow(this.env, data);
      ws.send(JSON.stringify(started));

      for (let poll = 0; poll < MAX_POLLS; poll++) {
        await sleep(POLL_INTERVAL_MS);
        const status = await getWorkflowStatus(this.env, started.instanceId);
        ws.send(JSON.stringify({ type: "workflow_status", ...status }));

        if (status.status !== "running") {
          if (status.response) ws.send(JSON.stringify(status.response));
          return;
        }
      }

      ws.send(JSON.stringify({
        type: "error",
        content: `Workflow ${started.instanceId} did not finish before WebSocket polling timed out`,
        sessionId: started.sessionId,
      }));
    } catch (error) {
      ws.send(JSON.stringify({
        type: "error",
        content: error instanceof Error ? error.message : String(error),
      }));
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
