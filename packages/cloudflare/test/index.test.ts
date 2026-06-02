/**
 * Unit tests for Cloudflare API egress handler
 */
import { describe, it, expect, vi } from "vitest";
import { registerEgressHandlers } from "../src/index.js";
import { EgressRegistry, type EgressContext, type EgressLogger } from "@clawflare/egress-core";

describe("cloudflare egress handler", () => {
  interface MockEnv {
    CLOUDFLARE_API_TOKEN: string;
    MOCK_AI?: string;
  }

  const createRegistry = () => new EgressRegistry<MockEnv>();
  const createLogger = (): EgressLogger => ({
    info: vi.fn(),
    warn: vi.fn(),
  });
  const createContext = (env: MockEnv): EgressContext<MockEnv> => ({ env, logger: createLogger() });

  describe("registration", () => {
    it("should register the cloudflare handler", () => {
      const registry = createRegistry();
      registerEgressHandlers(registry);

      const handler = registry.get("cloudflare");
      expect(handler).toBeDefined();
      expect(handler?.name).toBe("cloudflare");
      expect(handler?.description?.startsWith("Cloudflare REST API access")).toBe(true);
    });

    it("should register with correct domains", () => {
      const registry = createRegistry();
      registerEgressHandlers(registry);

      const handler = registry.get("cloudflare");
      expect(handler).toBeDefined();
      expect(handler?.domains).toEqual(["api.cloudflare.com"]);
    });
  });

  describe("handles", () => {
    it("should handle api.cloudflare.com", () => {
      const registry = createRegistry();
      registerEgressHandlers(registry);
      const handler = registry.get("cloudflare")!;

      expect(
        handler.handles(new Request("https://api.cloudflare.com/client/v4/zones"), createContext({ CLOUDFLARE_API_TOKEN: "test" }))
      ).toBe(true);
    });

    it("should not handle other domains", () => {
      const registry = createRegistry();
      registerEgressHandlers(registry);
      const handler = registry.get("cloudflare")!;

      expect(
        handler.handles(new Request("https://example.com"), createContext({ CLOUDFLARE_API_TOKEN: "test" }))
      ).toBe(false);
      expect(
        handler.handles(new Request("https://cloudflare.com"), createContext({ CLOUDFLARE_API_TOKEN: "test" }))
      ).toBe(false);
      expect(
        handler.handles(new Request("https://dash.cloudflare.com"), createContext({ CLOUDFLARE_API_TOKEN: "test" }))
      ).toBe(false);
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
      const data = await response.json() as { ok: boolean; handler: string; url: string };

      expect(data.ok).toBe(true);
      expect(data.handler).toBe("cloudflare");
      expect(data.url).toBe("https://api.cloudflare.com/client/v4/zones");
    });

    it("should add Authorization header with bearer token", async () => {
      const registry = createRegistry();
      registerEgressHandlers(registry);
      const handler = registry.get("cloudflare")!;

      const request = new Request("https://api.cloudflare.com/client/v4/zones");
      const context = createContext({ CLOUDFLARE_API_TOKEN: "cf_token_123" });

      const originalFetch = globalThis.fetch;
      let capturedRequest: Request | undefined;
      globalThis.fetch = vi.fn((req: Parameters<typeof fetch>[0]) => {
        capturedRequest = req as Request;
        return Promise.resolve(new Response(JSON.stringify({ success: true })));
      }) as typeof globalThis.fetch;

      try {
        await handler.fetch!(request, context);
        expect(capturedRequest).toBeDefined();
        expect(capturedRequest!.headers.get("Authorization")).toBe("Bearer cf_token_123");
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
      globalThis.fetch = vi.fn((req: Parameters<typeof fetch>[0]) => {
        capturedRequest = req as Request;
        return Promise.resolve(new Response(JSON.stringify({ success: true })));
      }) as typeof globalThis.fetch;

      try {
        await handler.fetch!(request, context);
        expect(capturedRequest!.method).toBe("POST");
        expect(capturedRequest!.headers.get("Content-Type")).toBe("application/json");
        expect(capturedRequest!.headers.get("X-Custom-Header")).toBe("custom-value");
        expect(capturedRequest!.headers.get("Authorization")).toBe("Bearer test");
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
      globalThis.fetch = vi.fn((req: Parameters<typeof fetch>[0]) => {
        capturedRequest = req as Request;
        return Promise.resolve(new Response(JSON.stringify({ success: true })));
      }) as typeof globalThis.fetch;

      try {
        await handler.fetch!(request, context);
        // Handler sets its own Authorization header
        expect(capturedRequest!.headers.get("Authorization")).toBe("Bearer new_token");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});
