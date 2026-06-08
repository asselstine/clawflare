import { describe, expect, it } from "vitest";
import { pendingToolPollDelayMs, toolExecutionTimeoutForDeadline } from "../src/runtime/workflow.js";

describe("workflow pending tool polling", () => {
  it("polls quickly at first and backs off for long-running commands", () => {
    const now = 1_000_000;

    expect(pendingToolPollDelayMs(now - 1_000, now)).toBe(250);
    expect(pendingToolPollDelayMs(now - 5_000, now)).toBe(500);
    expect(pendingToolPollDelayMs(now - 20_000, now)).toBe(1_000);
    expect(pendingToolPollDelayMs(now - 45_000, now)).toBe(2_000);
    expect(pendingToolPollDelayMs(now - 90_000, now)).toBe(5_000);
    expect(pendingToolPollDelayMs(now - 3 * 60_000, now)).toBe(10_000);
    expect(pendingToolPollDelayMs(now - 10 * 60_000, now)).toBe(25_000);
  });

  it("caps inline tool execution before the workflow run budget expires", () => {
    const now = 1_000_000;

    expect(toolExecutionTimeoutForDeadline(now + 20_000, now)).toBe(16_000);
    expect(toolExecutionTimeoutForDeadline(now + 3_000, now)).toBe(1);
  });
});
