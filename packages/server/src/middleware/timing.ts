import { createMiddleware } from "hono/factory";
import type { AppBindings } from "../http/app-bindings.js";
import { isTimingEnabled, timingStart } from "../lib/timing.js";
import { logger } from "../lib/logger.js";

export const timingMiddleware = createMiddleware<AppBindings>(async (c, next) => {
  const startedAt = timingStart();

  try {
    await next();
  } finally {
    if (!isTimingEnabled(c.env)) return;

    const requestContext = c.get("requestContext");
    const url = new URL(c.req.url);

    logger.info("HTTP request completed", {
      source: "clawflare-http-timing",
      method: c.req.method,
      path: url.pathname,
      status: c.res.status,
      elapsedMs: Date.now() - startedAt,
      workspaceId: requestContext?.workspace.id,
      userId: requestContext?.user.id,
    });
  }
});
