import { describe, expect, it } from "vitest";
import app from "../../../src/http/app.js";

describe("CORS", () => {
  it("answers API preflight requests", async () => {
    const response = await app.fetch(
      new Request("https://example.com/v1/auth/device/start", {
        method: "OPTIONS",
        headers: {
          Origin: "http://localhost:5174",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "content-type",
        },
      }),
      {} as never,
      {} as never
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Access-Control-Allow-Methods")).toContain("POST");
    expect(response.headers.get("Access-Control-Allow-Headers")).toContain("Content-Type");
  });

  it("attaches CORS headers to API responses", async () => {
    const response = await app.fetch(
      new Request("https://example.com/v1/unknown", {
        headers: {
          Origin: "http://localhost:5174",
        },
      }),
      {} as never,
      {} as never
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});
