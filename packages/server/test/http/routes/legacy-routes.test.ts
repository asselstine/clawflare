import { describe, expect, it } from "vitest";
import app from "../../../src/http/app.js";

describe("legacy routes", () => {
  it.each([
    ["GET", "/v1/info"],
    ["GET", "/v1/me"],
    ["GET", "/v1/auth/session"],
    ["GET", "/v1/context"],
    ["POST", "/v1/context"],
  ])("%s %s is removed", async (method, path) => {
    const response = await app.fetch(
      new Request(`https://example.com${path}`, { method }),
      {} as never,
      {} as never
    );

    expect(response.status).toBe(404);
  });
});
