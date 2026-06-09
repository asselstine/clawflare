import { describe, expect, it } from "vitest";
import { pendingToolFallbackDelayMs } from "../src/runtime/workflow.js";

describe("pending tool fallback delay", () => {
  it("checks quickly at first and backs off for long-running commands", () => {
    const now = 1_000_000;

    expect(pendingToolFallbackDelayMs(now - 1_000, now)).toBe(250);
    expect(pendingToolFallbackDelayMs(now - 5_000, now)).toBe(500);
    expect(pendingToolFallbackDelayMs(now - 20_000, now)).toBe(1_000);
    expect(pendingToolFallbackDelayMs(now - 45_000, now)).toBe(2_000);
    expect(pendingToolFallbackDelayMs(now - 90_000, now)).toBe(5_000);
    expect(pendingToolFallbackDelayMs(now - 3 * 60_000, now)).toBe(10_000);
    expect(pendingToolFallbackDelayMs(now - 10 * 60_000, now)).toBe(25_000);
  });
});
