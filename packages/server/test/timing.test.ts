import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { AppBindings } from "../src/http/app-bindings.js";
import { isTimingEnabled, logTiming, timingStart } from "../src/lib/timing.js";
import { timingMiddleware } from "../src/middleware/timing.js";

describe("timing", () => {
  it("detects enabled timing values", () => {
    expect(isTimingEnabled({})).toBe(false);
    expect(isTimingEnabled({ CLAWFLARE_DEBUG_TIMING: "false" })).toBe(false);
    expect(isTimingEnabled({ CLAWFLARE_DEBUG_TIMING: "true" })).toBe(true);
    expect(isTimingEnabled({ CLAWFLARE_DEBUG_TIMING: "1" })).toBe(true);
    expect(isTimingEnabled({ CLAWFLARE_DEBUG_TIMING: "YES" })).toBe(true);
  });

  it("logs stateless timing events when enabled", () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      logTiming(
        { CLAWFLARE_DEBUG_TIMING: "true" },
        "session-1",
        "test.phase",
        timingStart(),
        { count: 1 }
      );

      expect(consoleSpy).toHaveBeenCalledTimes(1);
      const logged = JSON.parse(consoleSpy.mock.calls[0]?.[0] as string);
      expect(logged.source).toBe("clawflare-timing");
      expect(logged.sessionId).toBe("session-1");
      expect(logged.phase).toBe("test.phase");
      expect(logged.count).toBe(1);
      expect(typeof logged.elapsedMs).toBe("number");
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("logs request timing from middleware", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const app = new Hono<AppBindings>();
    app.use("*", timingMiddleware);
    app.get("/health", (c) => c.json({ ok: true }));

    try {
      const response = await app.request(
        "/health",
        {},
        { CLAWFLARE_DEBUG_TIMING: "true" }
      );

      expect(response.status).toBe(200);
      expect(consoleSpy).toHaveBeenCalledTimes(1);
      const logged = JSON.parse(consoleSpy.mock.calls[0]?.[0] as string);
      expect(logged.source).toBe("clawflare-http-timing");
      expect(logged.method).toBe("GET");
      expect(logged.path).toBe("/health");
      expect(logged.status).toBe(200);
      expect(typeof logged.elapsedMs).toBe("number");
    } finally {
      consoleSpy.mockRestore();
    }
  });
});
