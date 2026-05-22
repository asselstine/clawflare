import { describe, expect, it } from "vitest";
import {
  DEFAULT_RUNTIME_NAMES,
  getConfigRuntimeNames,
  resolveRuntimeNames,
} from "../src/runtime-names.js";

describe("runtime names", () => {
  it("returns the built-in defaults", () => {
    expect(resolveRuntimeNames()).toEqual(DEFAULT_RUNTIME_NAMES);
  });

  it("applies explicit overrides", () => {
    expect(resolveRuntimeNames({ workerName: "custom-worker" }).workerName).toBe("custom-worker");
  });

  it("derives project runtime names from config", () => {
    expect(getConfigRuntimeNames({ name: "my-agent" })).toEqual({
      workerName: "my-agent",
      workflowName: "my-agent-workflow",
    });
  });

  it("folds in cloudflare name preferences and env suffixes", () => {
    expect(
      getConfigRuntimeNames(
        {
          name: "my-agent",
          cloudflare: {
            workerName: "preferred-worker",
            workflowName: "preferred-workflow",
          },
        },
        "staging",
      ),
    ).toEqual({
      workerName: "preferred-worker-staging",
      workflowName: "preferred-workflow-staging",
    });
  });
});
