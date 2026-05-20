// D1 Stored Code Repository Tests

import test from "node:test";
import assert from "node:assert/strict";
import { D1StoredCodeRepository } from "./d1-stored-code.js";
import type { UpsertStoredCodeParams, StoredCodeEntry } from "../interfaces.js";

test("D1StoredCodeRepository is defined", () => {
  assert.ok(D1StoredCodeRepository, "D1StoredCodeRepository should be defined");
});

test("UpsertStoredCodeParams type is valid", () => {
  const params: UpsertStoredCodeParams = {
    name: "test-script",
    code: "console.log('hello');",
    description: "A test script",
    tags: ["test", "example"],
  };

  assert.equal(params.name, "test-script");
  assert.equal(params.code, "console.log('hello');");
  assert.deepEqual(params.tags, ["test", "example"]);
});

test("StoredCodeEntry type includes timestamps", () => {
  const entry: StoredCodeEntry = {
    name: "test-script",
    code: "console.log('hello');",
    description: "A test script",
    tags: ["test"],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  assert.ok(typeof entry.createdAt === "number");
  assert.ok(typeof entry.updatedAt === "number");
});

export {};
