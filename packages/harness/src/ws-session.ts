import { DurableObject } from "cloudflare:workers";
import type { Env, ChatRequest, SessionState } from "./types";
// WebSocket session handler directly manages PersistentSessionWorkflow
import { loadSessionState, getSessionEvents, getLatestEventCursor, saveSessionState, enqueueSessionInput } from "./session-store";

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

      if (data.type !== "prompt" || !data.content) {
        ws.send(JSON.stringify({
          type: "error",
          content: "WebSocket sessions currently support prompt messages only",
        }));
        return;
      }

      // Create workflow ID for persistent session
      const sessionId = data.sessionId || crypto.randomUUID();
      const workflowId = crypto.randomUUID();
      
      // Initialize session state before starting workflow
      const initialEventCursor = await getLatestEventCursor(this.env, sessionId);
      const initialState: SessionState = {
        id: sessionId,
        workflowId,
        status: "processing" as const,
        messages: [],
        nextEventCursor: initialEventCursor,
        updatedAt: Date.now(),
      };
      await saveSessionState(this.env, initialState);
      
      // Create persistent workflow with initial params
      await this.env.AGENT_WORKFLOW.create({
        id: workflowId,
        params: { sessionId },
      });
      
      // Queue the event first for ordering
      await enqueueSessionInput(this.env, sessionId, {
        type: "prompt",
        content: data.content,
      });
      
      // Get workflow instance and wake it to consume the queued prompt.
      const workflowInstance = await this.env.AGENT_WORKFLOW.get(workflowId);
      await workflowInstance.sendEvent({
        type: "session-input",
        payload: { type: "wake" },
      });
      
      // Send initial session started event
      ws.send(JSON.stringify({
        type: "session_started",
        sessionId,
        eventCursor: "0",
      }));

      let cursor = "0";
      let sessionState: SessionState | null = null;
      
      for (let poll = 0; poll < MAX_POLLS; poll++) {
        await sleep(POLL_INTERVAL_MS);
        
        // Load session state (may not exist immediately)
        sessionState = await loadSessionState(this.env, sessionId);
        if (!sessionState) {
          // Session state may not be created yet, keep polling
          continue;
        }

        // Get new events
        const { events, nextCursor } = await getSessionEvents(
          this.env,
          sessionId,
          cursor,
          100
        );
        
        // Send events to client
        for (const event of events) {
          ws.send(JSON.stringify({ type: "agent_event", event }));
        }
        
        cursor = nextCursor;

        // Check if complete
        if (sessionState.status === "idle" || sessionState.status === "error") {
          // Get the last assistant message content
          const lastMsg = sessionState.messages.at(-1);
          let content = "";
          if (lastMsg?.role === "assistant") {
            const msgContent = lastMsg.content;
            if (Array.isArray(msgContent)) {
              // Extract text from TextContent blocks
              content = msgContent
                .filter((c): c is { type: "text"; text: string } => c.type === "text")
                .map(c => c.text)
                .join("");
            } else if (typeof msgContent === "string") {
              content = msgContent;
            }
          }
          
          // Send final message
          ws.send(JSON.stringify({
            type: "message",
            content: sessionState.errorMessage || content,
            sessionId,
            status: sessionState.status,
          }));
          return;
        }
      }

      ws.send(JSON.stringify({
        type: "error",
        content: `Session ${sessionId} did not finish before WebSocket polling timed out`,
        sessionId,
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
