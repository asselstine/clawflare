// D1 Stored Code Repository Tests

import { describe, it, expect } from "vitest";
import { StoredCodeRepository } from "../../../src/data/stored-code.js";
import type { UpsertStoredCodeParams, StoredCodeEntry } from "../../../src/data/index.js";

const DEFAULT_WORKSPACE_ID = "test-workspace";

describe("D1 Stored Code Repository", () => {
  it("StoredCodeRepository is defined", () => {
    expect(StoredCodeRepository).toBeDefined();
  });

  it("UpsertStoredCodeParams type is valid (workspace-scoped)", () => {
    const params: UpsertStoredCodeParams = {
      workspaceId: DEFAULT_WORKSPACE_ID,
      name: "test-script",
      code: "console.log('hello');",
      description: "A test script",
      tags: ["test", "example"],
    };

    expect(params.workspaceId).toBe(DEFAULT_WORKSPACE_ID);
    expect(params.name).toBe("test-script");
    expect(params.code).toBe("console.log('hello');");
    expect(params.tags).toEqual(["test", "example"]);
  });

  it("StoredCodeEntry type includes workspaceId and timestamps", () => {
    const entry: StoredCodeEntry = {
      workspaceId: DEFAULT_WORKSPACE_ID,
      name: "test-script",
      code: "console.log('hello');",
      description: "A test script",
      tags: ["test"],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    expect(entry.workspaceId).toBe(DEFAULT_WORKSPACE_ID);
    expect(typeof entry.createdAt).toBe("number");
    expect(typeof entry.updatedAt).toBe("number");
  });
});
