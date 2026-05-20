import type { Env } from "./internal-types/index.js";

export type { Env } from "./internal-types/index.js";

interface TimingEvent {
  phase: string;
  at: number;
  elapsedMs?: number;
  details?: Record<string, unknown>;
}

interface TimingSession {
  sessionId: string;
  events: TimingEvent[];
}

const sessions = new Map<string, TimingSession>();
const MAX_SESSIONS = 100;
const MAX_EVENTS_PER_SESSION = 1000;

/**
 * Check if timing debug is enabled.
 */
export function isTimingDebugEnabled(env: { CLAWFLARE_DEBUG_TIMING?: unknown }): boolean {
  const value = env.CLAWFLARE_DEBUG_TIMING;
  return value === "true" || value === "1" || value === "TRUE" || value === "True" || value === "YES" || value === "yes";
}

/**
 * Start timing a phase. Returns a timestamp that should be passed to logTiming.
 */
export function timingStart(): number {
  return Date.now();
}

/**
 * Log a timing event for diagnostics.
 */
export function logTiming(
  env: Env,
  sessionId: string | undefined,
  phase: string,
  startedAt?: number,
  details?: Record<string, unknown>,
): void {
  if (!isTimingDebugEnabled(env)) return;

  const now = Date.now();
  const elapsedMs = startedAt !== undefined ? now - startedAt : undefined;

  const sessionKey = sessionId ?? "__undefined__";
  let session = sessions.get(sessionKey);
  if (!session) {
    // Prune if at capacity
    if (sessions.size >= MAX_SESSIONS) {
      const oldest = sessions.keys().next().value;
      if (oldest) sessions.delete(oldest);
    }
    session = { sessionId: sessionId ?? "", events: [] };
    sessions.set(sessionKey, session);
  }

  // Prune events if at capacity
  if (session.events.length >= MAX_EVENTS_PER_SESSION) {
    session.events.shift();
  }

  session.events.push({
    phase,
    at: now,
    elapsedMs,
    details,
  });

  console.log(JSON.stringify({
    source: "clawflare-timing",
    sessionId,
    phase,
    at: Date.now(),
    ...(elapsedMs !== undefined ? { elapsedMs } : {}),
    ...(details ?? {}),
  }));
}

/**
 * Get timing events for a session.
 */
export function getTimingEvents(sessionId: string): TimingEvent[] {
  return sessions.get(sessionId)?.events ?? [];
}

/**
 * Get all active timing sessions.
 */
export function getTimingSessions(): TimingSession[] {
  return Array.from(sessions.values());
}

/**
 * Clear timing data for a session.
 */
export function clearTiming(sessionId: string): void {
  sessions.delete(sessionId);
}
