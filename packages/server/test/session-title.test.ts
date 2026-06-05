import { describe, expect, it } from "vitest";
import { createSessionTitleFromPrompt } from "../src/modules/sessions/session-title.js";

describe("createSessionTitleFromPrompt", () => {
  it("uses the first sentence and removes common connector words", () => {
    expect(createSessionTitleFromPrompt(
      "Please help me build a release checklist for the worker. Then run tests."
    )).toBe("build release checklist worker");
  });

  it("keeps meaningful prompts when connector removal would be too aggressive", () => {
    expect(createSessionTitleFromPrompt("And?")).toBe("And");
  });

  it("clips long titles at a word boundary", () => {
    expect(createSessionTitleFromPrompt(
      "Summarize the migration strategy for persistent runtime state across existing production sessions"
    )).toBe("Summarize migration strategy persistent runtime state");
  });

  it("returns undefined for blank prompts", () => {
    expect(createSessionTitleFromPrompt("   \n\t  ")).toBeUndefined();
  });
});
