import { logger } from "../../lib/logger.js";
import type { TimingEntry } from "../../lib/timing.js";

function isTimingEntry(value: unknown): value is TimingEntry {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { source?: unknown }).source === "clawflare-timing" &&
    typeof (value as { phase?: unknown }).phase === "string" &&
    typeof (value as { at?: unknown }).at === "number"
  );
}

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Not found", { status: 404 });
    }

    const body = await request.json().catch(() => null) as
      | { entries?: unknown; sessionId?: unknown; reason?: unknown }
      | null;
    const entries = Array.isArray(body?.entries)
      ? body.entries.filter(isTimingEntry)
      : [];

    for (const entry of entries) {
      logger.info("Timing event", {
        ...entry,
        emittedFrom: "timing-logger",
      });
    }

    logger.info("Workflow timing batch emitted", {
      source: "clawflare-workflow-timing",
      sessionId: typeof body?.sessionId === "string" ? body.sessionId : undefined,
      reason: typeof body?.reason === "string" ? body.reason : undefined,
      entryCount: entries.length,
    });

    return new Response(JSON.stringify({ ok: true, entryCount: entries.length }), {
      headers: { "Content-Type": "application/json" },
    });
  },
};
