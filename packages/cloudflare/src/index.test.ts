/**
 * Unit tests for Cloudflare API egress handler
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import { registerEgressHandlers } from "./index.js";
import { EgressRegistry, type EgressContext } from "@clawflare/egress-core";

describe("cloudflare egress handler", () => {
  interface MockEnv {
    CLOUDFLARE_API_TOKEN: string;
    MOCK_AI?: string;
  }

  const createRegistry = () => new EgressRegistry<MockEnv>();
  const createContext = (env: MockEnv): EgressContext<MockEnv> => ({ env });

  describe("registration", () => {
    it("should register the cloudflare handler", () => {
      const registry = createRegistry();
      registerEgressHandlers(registry);

      const handler = registry.get("cloudflare");
      assert.ok(handler);
      assert.strictEqual(handler.name, "cloudflare");
      assert.strictEqual(handler.description, "Cloudflare REST API access");
    });

    it("should register with correct domains", () => {
      const registry = createRegistry();
      registerEgressHandlers(registry);

      const handler = registry.get("cloudflare");
      assert.ok(handler);
      assert.deepStrictEqual(handler.domains, ["api.cloudflare.com"]);
    });
  });

  describe("handles", () => {
    it("should handle api.cloudflare.com", () => {
      const registry = createRegistry();
      registerEgressHandlers(registry);
      const handler = registry.get("cloudflare")!;

      assert.strictEqual(
        handler.handles(new Request("https://api.cloudflare.com/client/v4/zones"), createContext({ CLOUDFLARE_API_TOKEN: "test" })),
        true
      );
    });

    it("should not handle other domains", () => {
      const registry = createRegistry();
      registerEgressHandlers(registry);
      const handler = registry.get("cloudflare")!;

      assert.strictEqual(
        handler.handles(new Request("https://example.com"), createContext({ CLOUDFLARE_API_TOKEN: "test" })),
        false
      );
      assert.strictEqual(
        handler.handles(new Request("https://cloudflare.com"), createContext({ CLOUDFLARE_API_TOKEN: "test" })),
        false
      );
      assert.strictEqual(
        handler.handles(new Request("https://dash.cloudflare.com"), createContext({ CLOUDFLARE_API_TOKEN: "test" })),
        false
      );
    });
  });

  describe("fetch", () => {
    it("should return mock response in mock mode", async () => {
      const registry = createRegistry();
      registerEgressHandlers(registry);
      const handler = registry.get("cloudflare")!;

      const request = new Request("https://api.cloudflare.com/client/v4/zones");
      const context = createContext({ CLOUDFLARE_API_TOKEN: "test", MOCK_AI: "true" });

      const response = await handler.fetch!(request, context);
      const data = await response.json();

      assert.strictEqual(data.ok, true);
      assert.strictEqual(data.handler, "cloudflare");
      assert.strictEqual(data.url, "https://api.cloudflare.com/client/v4/zones");
    });

    it("should add Authorization header with bearer token", async () => {
      const registry = createRegistry();
      registerEgressHandlers(registry);
      const handler = registry.get("cloudflare")!;

      const request = new Request("https://api.cloudflare.com/client/v4/zones");
      const context = createContext({ CLOUDFLARE_API_TOKEN: "cf_token_123" });

      const originalFetch = globalThis.fetch;
      let capturedRequest: Request | undefined;
      globalThis.fetch = (req: RequestInfo | URL) => {
        capturedRequest = req as Request;
        return Promise.resolve(new Response(JSON.stringify({ success: true })));
      };

      try {
        await handler.fetch!(request, context);
        assert.ok(capturedRequest);
        assert.strictEqual(capturedRequest!.headers.get("Authorization"), "Bearer cf_token_123");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("should preserve existing request properties", async () => {
      const registry = createRegistry();
      registerEgressHandlers(registry);
      const handler = registry.get("cloudflare")!;

      const request = new Request("https://api.cloudflare.com/client/v4/zones", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Custom-Header": "custom-value",
        },
        body: JSON.stringify({ name: "example.com" }),
      });
      const context = createContext({ CLOUDFLARE_API_TOKEN: "test" });

      const originalFetch = globalThis.fetch;
      let capturedRequest: Request | undefined;
      globalThis.fetch = (req: RequestInfo | URL) => {
        capturedRequest = req as Request;
        return Promise.resolve(new Response(JSON.stringify({ success: true })));
      };

      try {
        await handler.fetch!(request, context);
        assert.strictEqual(capturedRequest!.method, "POST");
        assert.strictEqual(capturedRequest!.headers.get("Content-Type"), "application/json");
        assert.strictEqual(capturedRequest!.headers.get("X-Custom-Header"), "custom-value");
        assert.strictEqual(capturedRequest!.headers.get("Authorization"), "Bearer test");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("should override Authorization header", async () => {
      const registry = createRegistry();
      registerEgressHandlers(registry);
      const handler = registry.get("cloudflare")!;

      // Request with different auth header
      const request = new Request("https://api.cloudflare.com/client/v4/zones", {
        headers: {
          "Authorization": "Bearer old_token",
        },
      });
      const context = createContext({ CLOUDFLARE_API_TOKEN: "new_token" });

      const originalFetch = globalThis.fetch;
      let capturedRequest: Request | undefined;
      globalThis.fetch = (req: RequestInfo | URL) => {
        capturedRequest = req as Request;
        return Promise.resolve(new Response(JSON.stringify({ success: true })));
      };

      try {
        await handler.fetch!(request, context);
        // Handler sets its own Authorization header
        assert.strictEqual(capturedRequest!.headers.get("Authorization"), "Bearer new_token");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});
