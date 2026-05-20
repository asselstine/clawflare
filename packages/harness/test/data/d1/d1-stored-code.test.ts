// D1 Stored Code Repository Tests

import { describe, it, expect } from "vitest";
import { D1StoredCodeRepository } from "../../../src/data/d1/d1-stored-code.js";
import type { UpsertStoredCodeParams, StoredCodeEntry } from "../../../src/data/interfaces.js";

describe("D1 Stored Code Repository", () => {
  it("D1StoredCodeRepository is defined", () => {
    expect(D1StoredCodeRepository).toBeDefined();
  });

  it("UpsertStoredCodeParams type is valid", () => {
    const params: UpsertStoredCodeParams = {
      name: "test-script",
      code: "console.log('hello');",
      description: "A test script",
      tags: ["test", "example"],
    };

    expect(params.name).toBe("test-script");
    expect(params.code).toBe("console.log('hello');");
    expect(params.tags).toEqual(["test", "example"]);
  });

  it("StoredCodeEntry type includes timestamps", () => {
    const entry: StoredCodeEntry = {
      name: "test-script",
      code: "console.log('hello');",
      description: "A test script",
      tags: ["test"],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    expect(typeof entry.createdAt).toBe("number");
    expect(typeof entry.updatedAt).toBe("number");
  });
});
