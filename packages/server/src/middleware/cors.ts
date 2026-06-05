import type { Context, Next } from "hono";
import type { AppBindings } from "../http/app-bindings.js";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Authorization,Content-Type,Accept",
  "Access-Control-Max-Age": "86400",
};

export async function corsMiddleware(c: Context<AppBindings>, next: Next): Promise<Response | void> {
  if (c.req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: CORS_HEADERS,
    });
  }

  await next();

  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    c.res.headers.set(key, value);
  }
}
