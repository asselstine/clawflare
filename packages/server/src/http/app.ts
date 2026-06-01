import { Hono } from "hono";
import type { AppBindings } from "./app-bindings.js";
import { notFound, json } from "./responses.js";
import { authRoutes, meRoutes } from "../modules/auth/auth.routes.js";
import { chatRoutes } from "../modules/chat/chat.routes.js";
import { contextRoutes } from "../modules/context/context.routes.js";
import { debugRoutes } from "../modules/debug/debug.routes.js";
import { egressHandlersRoutes } from "../modules/egress-handlers/egress-handlers.routes.js";
import { infoRoutes } from "../modules/info/info.routes.js";
import {
  modelConnectionsRoutes,
  workspaceRoutes,
} from "../modules/model-connections/model-connections.routes.js";
import { providersRoutes } from "../modules/providers/providers.routes.js";
import { sessionRoutes, sessionsRoutes } from "../modules/sessions/sessions.routes.js";
import { toolsRoutes } from "../modules/tools/tools.routes.js";
import { errorMiddleware } from "../middleware/error.js";
import { requireAuth } from "../middleware/auth.js";
import { timingMiddleware } from "../middleware/timing.js";

const app = new Hono<AppBindings>();

app.onError(errorMiddleware);
app.notFound(() => notFound());

app.use("*", timingMiddleware);

app.use("*", async (c, next) => {
  const url = new URL(c.req.url);
  if (url.pathname !== "/" && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.replace(/\/+$/, "");
    return app.fetch(new Request(url.toString(), c.req.raw), c.env, c.executionCtx);
  }

  await next();
});

app.get("/health", () => json({ status: "ok" }));

app.route("/v1/auth", authRoutes);
app.route("/v1/me", meRoutes);
app.route("/v1/chat", chatRoutes);
app.route("/v1/session", sessionRoutes);
app.route("/v1/sessions", sessionsRoutes);
app.route("/v1/context", contextRoutes);
app.route("/v1/tools", toolsRoutes);
app.route("/v1/info", infoRoutes);
app.route("/v1/cf_debug", debugRoutes);
app.route("/v1/egress-handlers", egressHandlersRoutes);
app.route("/v1/providers", providersRoutes);
app.route("/v1/model-connections", modelConnectionsRoutes);
app.route("/v1/workspace", workspaceRoutes);

app.get("/ws", requireAuth, (c) => {
  const id = c.env.WEBSOCKET_SESSION.idFromName(crypto.randomUUID());
  return c.env.WEBSOCKET_SESSION.get(id).fetch(c.req.raw);
});

export default app;
