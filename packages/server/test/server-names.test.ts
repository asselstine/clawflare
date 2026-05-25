import { describe, expect, it } from "vitest";
import {
  DEFAULT_SERVER_NAMES,
  resolveServerNames,
} from "../src/server-names.js";

describe("server names", () => {
  it("returns the built-in defaults", () => {
    expect(resolveServerNames()).toEqual(DEFAULT_SERVER_NAMES);
  });

  it("applies explicit overrides", () => {
    expect(resolveServerNames({ workerName: "custom-worker" }).workerName).toBe("custom-worker");
  });
});
