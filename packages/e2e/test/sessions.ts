import type { E2ETestContext, E2ETestRunner } from "./support.js";
import { messageText } from "./support.js";

interface SessionCreateResponse {
  id?: string;
  eventCursor?: string;
}

interface SessionResponse {
  id?: string;
  name?: string;
  status?: string;
  errorMessage?: string;
  messages?: unknown[];
  events?: unknown[];
}

interface SessionListResponse {
  sessions?: Array<{
    id: string;
    name?: string;
    status?: string;
    containers?: string[];
  }>;
  total?: number;
}

interface SessionToolsResponse {
  groups?: unknown[];
  tools?: Array<{ name: string }>;
}

interface SessionContainersResponse {
  containers?: unknown[];
}

interface SessionRenameResponse {
  ok?: boolean;
  sessionId?: string;
  name?: string;
}

interface SessionControlResponse {
  ok?: boolean;
  sessionId?: string;
  status?: string;
  deleted?: boolean;
}

interface SessionDebugResponse {
  sessionId?: string;
  stats?: {
    eventCount?: number;
    queueDepth?: number;
  };
  recentEvents?: unknown[];
}

export async function runSessionTests(runner: E2ETestRunner, ctx: E2ETestContext): Promise<void> {
  const { client } = ctx;

  await runner.runTest("Create new session", async () => {
    const oldSessionId = client.getCurrentSessionId();
    const session = await client.createSession();
    if (!session.id) throw new Error("New session missing ID");
    if (session.id === oldSessionId) throw new Error("New session has same ID as old session");
  });

  await runner.runTest("Simple prompt", async () => {
    const submitted = await client.submitChat({ content: "Say 'hello'" });
    for await (const update of client.streamSession(submitted.sessionId)) {
      if (update.complete) {
        if (update.session.status === "error") {
          throw new Error(`Session failed: ${update.session.errorMessage}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
        const refreshed = await client.getSession(submitted.sessionId);
        const lastMsg = refreshed.messages.at(-1);
        if (!lastMsg || lastMsg.role !== "assistant") {
          throw new Error("Expected assistant response");
        }
        return;
      }
    }
    throw new Error("Session did not complete");
  });

  await runner.runTest("Session history preserved", async () => {
    await client.createSession();

    const submitted1 = await client.submitChat({ content: `First message: test-${Date.now()}` });
    let firstResponse = "";
    for await (const update of client.streamSession(submitted1.sessionId)) {
      if (update.complete) {
        const session = update.session.messages ? update.session : await client.getSession(submitted1.sessionId);
        const lastMsg = session.messages.at(-1);
        if (lastMsg?.role === "assistant") firstResponse = messageText(lastMsg);
        break;
      }
    }

    if (!firstResponse) throw new Error("First message failed - no response");
    console.error(`First response: ${firstResponse.substring(0, 60)}...`);

    await new Promise((resolve) => setTimeout(resolve, 1000));

    const submitted2 = await client.submitChat({
      content: "HISTORY_TEST: What messages have I sent?",
      sessionId: submitted1.sessionId,
    });
    console.error(`Second submit returned sessionId: ${submitted2.sessionId}`);

    let secondResponse = "";
    for await (const update of client.streamSession(submitted2.sessionId)) {
      console.error(`Polling second: status=${update.session.status}, messages=${update.session.messages?.length ?? 0}`);
      if (update.complete) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        const refreshed = await client.getSession(submitted2.sessionId);
        console.error(`Second complete: refreshed messages=${refreshed.messages.length}`);
        const lastMsg = refreshed.messages.at(-1);
        if (lastMsg?.role === "assistant") secondResponse = messageText(lastMsg);
        break;
      }
    }

    if (!secondResponse) throw new Error("Second message failed - no response");
    console.error(`Second response: ${secondResponse.substring(0, 100)}...`);

    if (!secondResponse.includes("HISTORY_TEST_MODE")) {
      throw new Error(`Expected HISTORY_TEST_MODE in response, got: ${secondResponse}`);
    }
  });

  await runner.runTest("Fork session", async () => {
    const session = await client.createSession();
    const originalId = session.id;
    const forkSession = await client.forkSession({
      parentSessionId: originalId,
      parentMessageId: "",
    });
    if (!forkSession.id) throw new Error("Fork failed - no session ID returned");
    if (forkSession.id === originalId) throw new Error("Fork returned same session ID");
  });

  await runner.runTest("Chat accepts steer-style content", async () => {
    const response = await ctx.authedFetch("/v1/chat", {
      method: "POST",
      body: JSON.stringify({ content: "Be more helpful" }),
    });
    if (response.status !== 200) throw new Error(`Expected 200, got ${response.status}`);
  });

  await runner.runTest("Session API: submit and poll for completion", async () => {
    const startResponse = await ctx.authedFetch("/v1/chat", {
      method: "POST",
      body: JSON.stringify({ content: "session smoke test" }),
    });
    const submitted = await startResponse.json() as { sessionId?: string; eventCursor?: string };
    if (!submitted.sessionId || !submitted.eventCursor) {
      throw new Error(`Session did not start: ${JSON.stringify(submitted)}`);
    }

    let lastStatus = "";
    for (let i = 0; i < 30; i++) {
      const sessionResponse = await ctx.authedFetch(`/v1/session/${submitted.sessionId}`);
      const session = await sessionResponse.json() as { status?: string; errorMessage?: string };
      lastStatus = JSON.stringify(session);
      if (session.status === "idle") return;
      if (session.status === "error") throw new Error(`Session errored: ${lastStatus}`);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error(`Session did not complete: ${lastStatus}`);
  });

  await runner.runTest("Session endpoints: metadata, tools, containers, debug, and lifecycle", async () => {
    const created = await ctx.authedJson<SessionCreateResponse>("/v1/session", {
      method: "POST",
      body: JSON.stringify({}),
    });
    const sessionId = created.id;
    if (!sessionId || !created.eventCursor) {
      throw new Error(`Session create failed: ${JSON.stringify(created)}`);
    }

    const session = await ctx.authedJson<SessionResponse>(`/v1/session/${sessionId}`);
    if (session.id !== sessionId || session.status !== "idle") {
      throw new Error(`Unexpected session metadata: ${JSON.stringify(session)}`);
    }
    if (!Array.isArray(session.events) || !Array.isArray(session.messages)) {
      throw new Error(`Session response should include events and messages arrays: ${JSON.stringify(session)}`);
    }

    const listed = await ctx.authedJson<SessionListResponse>(`/v1/sessions?sessionId=${sessionId}`);
    if (listed.total !== 1 || listed.sessions?.[0]?.id !== sessionId) {
      throw new Error(`Session list did not include created session: ${JSON.stringify(listed)}`);
    }

    const tools = await ctx.authedJson<SessionToolsResponse>(`/v1/session/${sessionId}/tools`);
    if (!tools.tools?.some((tool) => tool.name === "execute_code")) {
      throw new Error(`Session tool list missing execute_code: ${JSON.stringify(tools)}`);
    }

    const containers = await ctx.authedJson<SessionContainersResponse>(`/v1/session/${sessionId}/containers`);
    if (!Array.isArray(containers.containers)) {
      throw new Error(`Session container list should return an array: ${JSON.stringify(containers)}`);
    }

    const renamed = await ctx.authedJson<SessionRenameResponse>(`/v1/session/${sessionId}/name`, {
      method: "POST",
      body: JSON.stringify({ name: "api smoke session" }),
    });
    if (!renamed.ok || renamed.sessionId !== sessionId || renamed.name !== "api_smoke_session") {
      throw new Error(`Session rename failed: ${JSON.stringify(renamed)}`);
    }

    const debug = await ctx.authedJson<SessionDebugResponse>(`/v1/cf_debug?sessionId=${sessionId}`);
    if (debug.sessionId !== sessionId || typeof debug.stats?.eventCount !== "number") {
      throw new Error(`Session debug response mismatch: ${JSON.stringify(debug)}`);
    }

    const aborted = await ctx.authedJson<SessionControlResponse>(`/v1/session/${sessionId}/abort`, {
      method: "POST",
    });
    if (!aborted.ok || aborted.sessionId !== sessionId) {
      throw new Error(`Session abort failed: ${JSON.stringify(aborted)}`);
    }

    const stopped = await ctx.authedJson<SessionControlResponse>(`/v1/session/${sessionId}/stop`, {
      method: "POST",
    });
    if (!stopped.ok || stopped.sessionId !== sessionId) {
      throw new Error(`Session stop failed: ${JSON.stringify(stopped)}`);
    }

    const closed = await ctx.authedJson<SessionControlResponse>(`/v1/session/${sessionId}/close`, {
      method: "POST",
    });
    if (!closed.ok || closed.sessionId !== sessionId || closed.status !== "closed") {
      throw new Error(`Session close failed: ${JSON.stringify(closed)}`);
    }

    const deleted = await ctx.authedJson<SessionControlResponse>(`/v1/session/${sessionId}`, {
      method: "DELETE",
    });
    if (!deleted.ok || !deleted.deleted || deleted.sessionId !== sessionId) {
      throw new Error(`Session delete failed: ${JSON.stringify(deleted)}`);
    }
  });

  await runner.runTest("WebSocket starts workflow and streams final response", async () => {
    const ws = await client.connectWebSocket();
    try {
      const result = await new Promise<{ type?: string; content?: string }>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Timed out waiting for WebSocket workflow response")), 120000);

        ws.on("message", (data) => {
          const message = JSON.parse(data.toString()) as { type?: string; content?: string };
          if (message.type === "error") {
            clearTimeout(timeout);
            reject(new Error(message.content || "WebSocket returned error"));
            return;
          }
          if (message.type === "message") {
            clearTimeout(timeout);
            resolve(message);
          }
        });
        ws.on("error", (error) => {
          clearTimeout(timeout);
          reject(error);
        });

        ws.send(JSON.stringify({ content: "websocket workflow smoke test" }));
      });

      if (result.type !== "message" || !result.content) {
        throw new Error(`Unexpected WebSocket result: ${JSON.stringify(result)}`);
      }
    } finally {
      ws.close();
    }
  });
}
