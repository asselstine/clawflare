import { createMiddleware } from "hono/factory";
import type { AppBindings } from "../http/app-bindings.js";
import { unauthorized } from "../http/responses.js";
import { resolveRequestContext } from "../http/request-context.js";

export const requireAuth = createMiddleware<AppBindings>(async (c, next) => {
  const requestContext = await resolveRequestContext(c.req.raw, c.env);

  if (!requestContext) {
    return unauthorized("Invalid or missing authentication");
  }

  c.set("requestContext", requestContext);
  await next();
});
