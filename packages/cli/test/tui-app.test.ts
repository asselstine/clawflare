import { describe, expect, it } from "vitest";
import { getPersistedToolResultIsError, getToolCallVisualState } from "../src/tui-app.js";

describe("getPersistedToolResultIsError", () => {
  it("treats persisted execution details with ok false as an error", () => {
    expect(getPersistedToolResultIsError({ isError: false, details: { ok: false } })).toBe(true);
  });
});

describe("getToolCallVisualState", () => {
  it("treats a pending tool call with a result as complete", () => {
    expect(getToolCallVisualState("pending", { isError: false })).toEqual({
      hasError: false,
      isComplete: true,
    });
  });

  it("keeps running tool calls without results incomplete", () => {
    expect(getToolCallVisualState("running", undefined)).toEqual({
      hasError: false,
      isComplete: false,
    });
  });

  it("uses result errors even when the status was not updated", () => {
    expect(getToolCallVisualState("pending", { isError: true })).toEqual({
      hasError: true,
      isComplete: false,
    });
  });
});
