import { createMiddleware } from "hono/factory";
import type { AppBindings } from "../http/app-bindings.js";
import { unauthorized } from "../http/responses.js";
import { resolveRequestContext } from "../http/request-context.js";
import { logTiming, timingStart } from "../lib/timing.js";

export const requireAuth = createMiddleware<AppBindings>(async (c, next) => {
  const authStart = timingStart();
  const requestContext = await resolveRequestContext(c.req.raw, c.env);
  const authElapsedMs = Date.now() - authStart;
  const url = new URL(c.req.url);

  if (!requestContext) {
    logTiming(c.env, undefined, "auth.context.failed", authStart, {
      method: c.req.method,
      path: url.pathname,
      authElapsedMs,
    });
    return unauthorized("Invalid or missing authentication");
  }

  c.set("requestContext", requestContext);
  c.header("Server-Timing", `auth;dur=${authElapsedMs}`);
  logTiming(c.env, undefined, "auth.context.resolved", authStart, {
    method: c.req.method,
    path: url.pathname,
    authElapsedMs,
    userId: requestContext.user.id,
    workspaceId: requestContext.workspace.id,
    authType: requestContext.accessTokenId ? "bearer" : requestContext.sessionId ? "session" : "unknown",
  });
  await next();
});
