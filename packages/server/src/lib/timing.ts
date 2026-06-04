import { logger } from "./logger.js";

export interface TimingEntry {
  source: "clawflare-timing";
  sessionId?: string;
  phase: string;
  at: number;
  elapsedMs?: number;
  [key: string]: unknown;
}

export function isTimingEnabled(env: { CLAWFLARE_DEBUG_TIMING?: unknown }): boolean {
  const value = env.CLAWFLARE_DEBUG_TIMING;
  return value === "true" || value === "1" || value === "TRUE" || value === "True" || value === "YES" || value === "yes";
}

export function timingStart(): number {
  return Date.now();
}

export function createTimingEntry(
  sessionId: string | undefined,
  phase: string,
  startedAt?: number,
  details?: Record<string, unknown>,
): TimingEntry {
  const now = Date.now();
  const elapsedMs = startedAt === undefined ? undefined : now - startedAt;

  return {
    source: "clawflare-timing",
    sessionId,
    phase,
    at: now,
    ...(elapsedMs === undefined ? {} : { elapsedMs }),
    ...(details ?? {}),
  };
}

export function logTimingEntry(entry: TimingEntry): void {
  logger.info("Timing event", entry);
}

export function logTiming(
  env: { CLAWFLARE_DEBUG_TIMING?: unknown },
  sessionId: string | undefined,
  phase: string,
  startedAt?: number,
  details?: Record<string, unknown>,
): void {
  if (!isTimingEnabled(env)) return;

  const entry = createTimingEntry(sessionId, phase, startedAt, details);
  logTimingEntry(entry);
}

export class TimingCollector {
  private readonly entries: TimingEntry[] = [];

  record(entry: TimingEntry): void {
    this.entries.push(entry);
  }

  flush(): TimingEntry[] {
    return this.entries.splice(0);
  }
}

export function collectTiming(
  env: { CLAWFLARE_DEBUG_TIMING?: unknown },
  collector: TimingCollector | undefined,
  sessionId: string | undefined,
  phase: string,
  startedAt?: number,
  details?: Record<string, unknown>,
): void {
  if (!isTimingEnabled(env)) return;

  const entry = createTimingEntry(sessionId, phase, startedAt, details);
  collector?.record(entry);
  logTimingEntry(entry);
}

export async function flushTimingCollector(
  env: { CLAWFLARE_DEBUG_TIMING?: unknown; TIMING_LOGGER?: Fetcher },
  collector: TimingCollector | undefined,
  details: Record<string, unknown> = {},
): Promise<void> {
  if (!isTimingEnabled(env) || !collector || !env.TIMING_LOGGER) return;

  const entries = collector.flush();
  if (entries.length === 0) return;

  try {
    await env.TIMING_LOGGER.fetch("https://timing-logger/workflow", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entries, ...details }),
    });
  } catch (error) {
    logger.error("Failed to flush workflow timing logs", error, {
      source: "clawflare-timing",
      entryCount: entries.length,
      ...details,
    });
  }
}
