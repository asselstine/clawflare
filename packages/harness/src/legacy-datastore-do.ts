/**
 * Legacy ClawflareDatastore Durable Object.
 *
 * D1 is the source of truth. This no-op class exists only so append-only
 * Durable Object migration history can reference the original class before the
 * later deletion migration.
 */
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./internal-types/index.js";

export class ClawflareDatastore extends DurableObject<Env> {
  constructor(ctx: DurableObjectState<Env>, env: Env) {
    super(ctx, env);
  }

  fetch(): Response {
    return new Response(JSON.stringify({ error: "ClawflareDatastore is deprecated; D1 is the source of truth" }), {
      status: 410,
      headers: { "Content-Type": "application/json" },
    });
  }
}
