/**
 * Unit tests for diagnostics utilities
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import {
  timingStart,
  isTimingDebugEnabled,
  logTiming,
  type Env,
} from "./diagnostics.js";

describe("diagnostics", () => {
  describe("timingStart", () => {
    it("should return current timestamp", () => {
      const before = Date.now();
      const start = timingStart();
      const after = Date.now();

      assert.strictEqual(typeof start, "number");
      assert(start >= before);
      assert(start <= after);
    });
  });

  describe("isTimingDebugEnabled", () => {
    it("should return false when CLAWFLARE_DEBUG_TIMING is undefined", () => {
      const env: Pick<Env, "CLAWFLARE_DEBUG_TIMING"> = {};
      assert.strictEqual(isTimingDebugEnabled(env), false);
    });

    it("should return false when CLAWFLARE_DEBUG_TIMING is empty", () => {
      const env: Pick<Env, "CLAWFLARE_DEBUG_TIMING"> = { CLAWFLARE_DEBUG_TIMING: "" };
      assert.strictEqual(isTimingDebugEnabled(env), false);
    });

    it("should return true when CLAWFLARE_DEBUG_TIMING is '1'", () => {
      const env: Pick<Env, "CLAWFLARE_DEBUG_TIMING"> = { CLAWFLARE_DEBUG_TIMING: "1" };
      assert.strictEqual(isTimingDebugEnabled(env), true);
    });

    it("should return true when CLAWFLARE_DEBUG_TIMING is 'true'", () => {
      const env: Pick<Env, "CLAWFLARE_DEBUG_TIMING"> = { CLAWFLARE_DEBUG_TIMING: "true" };
      assert.strictEqual(isTimingDebugEnabled(env), true);
    });

    it("should return true when CLAWFLARE_DEBUG_TIMING is 'yes'", () => {
      const env: Pick<Env, "CLAWFLARE_DEBUG_TIMING"> = { CLAWFLARE_DEBUG_TIMING: "yes" };
      assert.strictEqual(isTimingDebugEnabled(env), true);
    });

    it("should be case-insensitive", () => {
      assert.strictEqual(
        isTimingDebugEnabled({ CLAWFLARE_DEBUG_TIMING: "TRUE" }),
        true
      );
      assert.strictEqual(
        isTimingDebugEnabled({ CLAWFLARE_DEBUG_TIMING: "True" }),
        true
      );
      assert.strictEqual(
        isTimingDebugEnabled({ CLAWFLARE_DEBUG_TIMING: "YES" }),
        true
      );
    });

    it("should return false for other values", () => {
      assert.strictEqual(
        isTimingDebugEnabled({ CLAWFLARE_DEBUG_TIMING: "false" }),
        false
      );
      assert.strictEqual(
        isTimingDebugEnabled({ CLAWFLARE_DEBUG_TIMING: "no" }),
        false
      );
      assert.strictEqual(
        isTimingDebugEnabled({ CLAWFLARE_DEBUG_TIMING: "enable" }),
        false
      );
    });
  });

  describe("logTiming", () => {
    const originalConsoleLog = console.log;
    let loggedMessages: unknown[] = [];

    beforeEach(() => {
      loggedMessages = [];
      console.log = (...args: unknown[]) => {
        loggedMessages.push(args);
      };
    });

    afterEach(() => {
      console.log = originalConsoleLog;
    });

    it("should not log when debug is disabled", () => {
      const env: Pick<Env, "CLAWFLARE_DEBUG_TIMING"> = {};
      logTiming(env, "session-123", "test.phase");
      assert.strictEqual(loggedMessages.length, 0);
    });

    it("should log JSON formatted message when debug is enabled", () => {
      const env: Pick<Env, "CLAWFLARE_DEBUG_TIMING"> = { CLAWFLARE_DEBUG_TIMING: "true" };
      logTiming(env, "session-123", "test.phase");

      assert.strictEqual(loggedMessages.length, 1);
      const logged = JSON.parse(loggedMessages[0] as string);
      assert.strictEqual(logged.source, "clawflare-timing");
      assert.strictEqual(logged.sessionId, "session-123");
      assert.strictEqual(logged.phase, "test.phase");
      assert.strictEqual(typeof logged.at, "number");
      assert.strictEqual(logged.elapsedMs, undefined);
    });

    it("should calculate elapsed time when startedAt is provided", () => {
      const env: Pick<Env, "CLAWFLARE_DEBUG_TIMING"> = { CLAWFLARE_DEBUG_TIMING: "true" };
      const start = Date.now() - 100; // Simulate 100ms elapsed

      logTiming(env, "session-123", "test.phase", start);

      const logged = JSON.parse(loggedMessages[0] as string);
      assert.strictEqual(typeof logged.elapsedMs, "number");
      assert(logged.elapsedMs >= 100);
    });

    it("should include additional details", () => {
      const env: Pick<Env, "CLAWFLARE_DEBUG_TIMING"> = { CLAWFLARE_DEBUG_TIMING: "true" };
      logTiming(env, "session-123", "test.phase", undefined, {
        customField: "value",
        count: 42,
      });

      const logged = JSON.parse(loggedMessages[0] as string);
      assert.strictEqual(logged.customField, "value");
      assert.strictEqual(logged.count, 42);
    });

    it("should handle undefined sessionId", () => {
      const env: Pick<Env, "CLAWFLARE_DEBUG_TIMING"> = { CLAWFLARE_DEBUG_TIMING: "true" };
      logTiming(env, undefined, "test.phase");

      const logged = JSON.parse(loggedMessages[0] as string);
      assert.strictEqual(logged.sessionId, undefined);
    });

    it("should combine elapsedMs with details", () => {
      const env: Pick<Env, "CLAWFLARE_DEBUG_TIMING"> = { CLAWFLARE_DEBUG_TIMING: "true" };
      const start = Date.now() - 50;

      logTiming(env, "session-123", "test.phase", start, {
        operation: "db-write",
      });

      const logged = JSON.parse(loggedMessages[0] as string);
      assert.strictEqual(typeof logged.elapsedMs, "number");
      assert.strictEqual(logged.operation, "db-write");
      assert(logged.elapsedMs >= 50);
    });
  });
});
