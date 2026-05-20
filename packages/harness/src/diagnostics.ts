import type { Env } from "./types";

export function timingStart(): number {
  return Date.now();
}

export function isTimingDebugEnabled(env: Pick<Env, "CLAWFLARE_DEBUG_TIMING">): boolean {
  const value = env.CLAWFLARE_DEBUG_TIMING?.toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

export function logTiming(
  env: Pick<Env, "CLAWFLARE_DEBUG_TIMING">,
  sessionId: string | undefined,
  phase: string,
  startedAt?: number,
  details: Record<string, unknown> = {},
): void {
  if (!isTimingDebugEnabled(env)) return;

  const now = Date.now();
  console.log(JSON.stringify({
    source: "clawflare-timing",
    sessionId,
    phase,
    at: now,
    elapsedMs: startedAt === undefined ? undefined : now - startedAt,
    ...details,
  }));
}
