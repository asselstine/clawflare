import { describe, expect, it } from "vitest";
import {
  DEFAULT_SERVER_NAMES,
  getConfigServerNames,
  resolveServerNames,
} from "../src/server-names.js";

describe("server names", () => {
  it("returns the built-in defaults", () => {
    expect(resolveServerNames()).toEqual(DEFAULT_SERVER_NAMES);
  });

  it("applies explicit overrides", () => {
    expect(resolveServerNames({ workerName: "custom-worker" }).workerName).toBe("custom-worker");
  });

  it("derives project server names from config", () => {
    expect(getConfigServerNames({ name: "my-agent" })).toEqual({
      workerName: "my-agent",
      workflowName: "my-agent-workflow",
    });
  });

  it("folds in cloudflare name preferences and env suffixes", () => {
    expect(
      getConfigServerNames(
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
