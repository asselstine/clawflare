/**
 * Unit tests for diagnostics utilities
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  timingStart,
  isTimingDebugEnabled,
  logTiming,
  type Env,
} from "../src/diagnostics.js";

describe("diagnostics", () => {
  describe("timingStart", () => {
    it("should return current timestamp", () => {
      const before = Date.now();
      const start = timingStart();
      const after = Date.now();

      expect(typeof start).toBe("number");
      expect(start).toBeGreaterThanOrEqual(before);
      expect(start).toBeLessThanOrEqual(after);
    });
  });

  describe("isTimingDebugEnabled", () => {
    it("should return false when CLAWFLARE_DEBUG_TIMING is undefined", () => {
      const env: Pick<Env, "CLAWFLARE_DEBUG_TIMING"> = {};
      expect(isTimingDebugEnabled(env)).toBe(false);
    });

    it("should return false when CLAWFLARE_DEBUG_TIMING is empty", () => {
      const env: Pick<Env, "CLAWFLARE_DEBUG_TIMING"> = { CLAWFLARE_DEBUG_TIMING: "" };
      expect(isTimingDebugEnabled(env)).toBe(false);
    });

    it("should return true when CLAWFLARE_DEBUG_TIMING is '1'", () => {
      const env: Pick<Env, "CLAWFLARE_DEBUG_TIMING"> = { CLAWFLARE_DEBUG_TIMING: "1" };
      expect(isTimingDebugEnabled(env)).toBe(true);
    });

    it("should return true when CLAWFLARE_DEBUG_TIMING is 'true'", () => {
      const env: Pick<Env, "CLAWFLARE_DEBUG_TIMING"> = { CLAWFLARE_DEBUG_TIMING: "true" };
      expect(isTimingDebugEnabled(env)).toBe(true);
    });

    it("should return true when CLAWFLARE_DEBUG_TIMING is 'yes'", () => {
      const env: Pick<Env, "CLAWFLARE_DEBUG_TIMING"> = { CLAWFLARE_DEBUG_TIMING: "yes" };
      expect(isTimingDebugEnabled(env)).toBe(true);
    });

    it("should be case-insensitive", () => {
      expect(
        isTimingDebugEnabled({ CLAWFLARE_DEBUG_TIMING: "TRUE" })
      ).toBe(true);
      expect(
        isTimingDebugEnabled({ CLAWFLARE_DEBUG_TIMING: "True" })
      ).toBe(true);
      expect(
        isTimingDebugEnabled({ CLAWFLARE_DEBUG_TIMING: "YES" })
      ).toBe(true);
    });

    it("should return false for other values", () => {
      expect(
        isTimingDebugEnabled({ CLAWFLARE_DEBUG_TIMING: "false" })
      ).toBe(false);
      expect(
        isTimingDebugEnabled({ CLAWFLARE_DEBUG_TIMING: "no" })
      ).toBe(false);
      expect(
        isTimingDebugEnabled({ CLAWFLARE_DEBUG_TIMING: "enable" })
      ).toBe(false);
    });
  });

  describe("logTiming", () => {
    const originalConsoleLog = console.log;
    let loggedMessages: unknown[] = [];

    beforeEach(() => {
      loggedMessages = [];
      console.log = vi.fn((...args: unknown[]) => {
        loggedMessages.push(args);
      });
    });

    afterEach(() => {
      console.log = originalConsoleLog;
    });

    it("should not log when debug is disabled", () => {
      const env: Pick<Env, "CLAWFLARE_DEBUG_TIMING"> = {};
      logTiming(env, "session-123", "test.phase");
      expect(loggedMessages.length).toBe(0);
    });

    it("should log JSON formatted message when debug is enabled", () => {
      const env: Pick<Env, "CLAWFLARE_DEBUG_TIMING"> = { CLAWFLARE_DEBUG_TIMING: "true" };
      logTiming(env, "session-123", "test.phase");

      expect(loggedMessages.length).toBe(1);
      const logged = JSON.parse(loggedMessages[0] as string);
      expect(logged.source).toBe("clawflare-timing");
      expect(logged.sessionId).toBe("session-123");
      expect(logged.phase).toBe("test.phase");
      expect(typeof logged.at).toBe("number");
      expect(logged.elapsedMs).toBeUndefined();
    });

    it("should calculate elapsed time when startedAt is provided", () => {
      const env: Pick<Env, "CLAWFLARE_DEBUG_TIMING"> = { CLAWFLARE_DEBUG_TIMING: "true" };
      const start = Date.now() - 100; // Simulate 100ms elapsed

      logTiming(env, "session-123", "test.phase", start);

      const logged = JSON.parse(loggedMessages[0] as string);
      expect(typeof logged.elapsedMs).toBe("number");
      expect(logged.elapsedMs).toBeGreaterThanOrEqual(100);
    });

    it("should include additional details", () => {
      const env: Pick<Env, "CLAWFLARE_DEBUG_TIMING"> = { CLAWFLARE_DEBUG_TIMING: "true" };
      logTiming(env, "session-123", "test.phase", undefined, {
        customField: "value",
        count: 42,
      });

      const logged = JSON.parse(loggedMessages[0] as string);
      expect(logged.customField).toBe("value");
      expect(logged.count).toBe(42);
    });

    it("should handle undefined sessionId", () => {
      const env: Pick<Env, "CLAWFLARE_DEBUG_TIMING"> = { CLAWFLARE_DEBUG_TIMING: "true" };
      logTiming(env, undefined, "test.phase");

      const logged = JSON.parse(loggedMessages[0] as string);
      expect(logged.sessionId).toBeUndefined();
    });

    it("should combine elapsedMs with details", () => {
      const env: Pick<Env, "CLAWFLARE_DEBUG_TIMING"> = { CLAWFLARE_DEBUG_TIMING: "true" };
      const start = Date.now() - 50;

      logTiming(env, "session-123", "test.phase", start, {
        operation: "db-write",
      });

      const logged = JSON.parse(loggedMessages[0] as string);
      expect(typeof logged.elapsedMs).toBe("number");
      expect(logged.operation).toBe("db-write");
      expect(logged.elapsedMs).toBeGreaterThanOrEqual(50);
    });
  });
});
