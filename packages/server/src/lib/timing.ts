import { logger } from "./logger.js";

export function isTimingEnabled(env: { CLAWFLARE_DEBUG_TIMING?: unknown }): boolean {
  const value = env.CLAWFLARE_DEBUG_TIMING;
  return value === "true" || value === "1" || value === "TRUE" || value === "True" || value === "YES" || value === "yes";
}

export function timingStart(): number {
  return Date.now();
}

export function logTiming(
  env: { CLAWFLARE_DEBUG_TIMING?: unknown },
  sessionId: string | undefined,
  phase: string,
  startedAt?: number,
  details?: Record<string, unknown>,
): void {
  if (!isTimingEnabled(env)) return;

  const now = Date.now();
  const elapsedMs = startedAt === undefined ? undefined : now - startedAt;

  logger.info("Timing event", {
    source: "clawflare-timing",
    sessionId,
    phase,
    at: now,
    ...(elapsedMs === undefined ? {} : { elapsedMs }),
    ...(details ?? {}),
  });
}
