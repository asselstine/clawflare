/**
 * Unit tests for Netlify API egress handler
 */
import { describe, expect, it, vi } from "vitest";
import { EgressRegistry, type EgressContext, type EgressLogger } from "@clawflare/egress-core";
import { registerEgressHandlers } from "../src/index.js";

describe("netlify egress handler", () => {
  interface MockEnv {
    NETLIFY_AUTH_TOKEN: string;
    MOCK_EGRESS?: string;
  }

  const createRegistry = () => new EgressRegistry<MockEnv>();
  const createLogger = (): EgressLogger => ({
    info: vi.fn(),
    warn: vi.fn(),
  });
  const createContext = (env: MockEnv): EgressContext<MockEnv> => ({ env, logger: createLogger() });

  describe("registration", () => {
    it("registers the netlify handler", () => {
      const registry = createRegistry();
      registerEgressHandlers(registry);

      const handler = registry.get("netlify");
      expect(handler).toBeDefined();
      expect(handler?.name).toBe("netlify");
      expect(handler?.description?.startsWith("Netlify REST API access")).toBe(true);
    });

    it("registers with the Netlify API domain", () => {
      const registry = createRegistry();
      registerEgressHandlers(registry);

      const handler = registry.get("netlify");
      expect(handler).toBeDefined();
      expect(handler?.domains).toEqual(["api.netlify.com"]);
    });
  });

  describe("handles", () => {
    it("handles api.netlify.com", () => {
      const registry = createRegistry();
      registerEgressHandlers(registry);
      const handler = registry.get("netlify")!;

      expect(
        handler.handles(new Request("https://api.netlify.com/api/v1/sites"), createContext({ NETLIFY_AUTH_TOKEN: "test" }))
      ).toBe(true);
    });

    it("does not handle other Netlify domains", () => {
      const registry = createRegistry();
      registerEgressHandlers(registry);
      const handler = registry.get("netlify")!;

      expect(
        handler.handles(new Request("https://app.netlify.com"), createContext({ NETLIFY_AUTH_TOKEN: "test" }))
      ).toBe(false);
      expect(
        handler.handles(new Request("https://docs.netlify.com"), createContext({ NETLIFY_AUTH_TOKEN: "test" }))
      ).toBe(false);
      expect(
        handler.handles(new Request("https://example.com"), createContext({ NETLIFY_AUTH_TOKEN: "test" }))
      ).toBe(false);
    });
  });

  describe("fetch", () => {
    it("returns mock response in mock mode", async () => {
      const registry = createRegistry();
      registerEgressHandlers(registry);
      const handler = registry.get("netlify")!;

      const request = new Request("https://api.netlify.com/api/v1/sites");
      const context = createContext({ NETLIFY_AUTH_TOKEN: "test", MOCK_EGRESS: "true" });

      const response = await handler.fetch!(request, context);
      const data = await response.json() as { ok: boolean; handler: string; url: string };

      expect(data.ok).toBe(true);
      expect(data.handler).toBe("netlify");
      expect(data.url).toBe("https://api.netlify.com/api/v1/sites");
    });

    it("adds Authorization and User-Agent headers", async () => {
      const registry = createRegistry();
      registerEgressHandlers(registry);
      const handler = registry.get("netlify")!;

      const request = new Request("https://api.netlify.com/api/v1/sites");
      const context = createContext({ NETLIFY_AUTH_TOKEN: "nfp_test_token" });

      const originalFetch = globalThis.fetch;
      let capturedRequest: Request | undefined;
      globalThis.fetch = vi.fn((req: Parameters<typeof fetch>[0]) => {
        capturedRequest = req as Request;
        return Promise.resolve(new Response(JSON.stringify({ ok: true })));
      }) as typeof globalThis.fetch;

      try {
        await handler.fetch!(request, context);
        expect(capturedRequest).toBeDefined();
        expect(capturedRequest!.headers.get("Authorization")).toBe("Bearer nfp_test_token");
        expect(capturedRequest!.headers.get("User-Agent")).toBe("Clawflare-Agent");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("preserves deploy upload request properties", async () => {
      const registry = createRegistry();
      registerEgressHandlers(registry);
      const handler = registry.get("netlify")!;

      const request = new Request("https://api.netlify.com/api/v1/sites/site-id/deploys", {
        method: "POST",
        headers: {
          "Content-Type": "application/zip",
          "X-Custom-Header": "custom-value",
        },
        body: "zip-bytes",
      });
      const context = createContext({ NETLIFY_AUTH_TOKEN: "test" });

      const originalFetch = globalThis.fetch;
      let capturedRequest: Request | undefined;
      globalThis.fetch = vi.fn((req: Parameters<typeof fetch>[0]) => {
        capturedRequest = req as Request;
        return Promise.resolve(new Response(JSON.stringify({ id: "deploy-id" })));
      }) as typeof globalThis.fetch;

      try {
        await handler.fetch!(request, context);
        expect(capturedRequest!.method).toBe("POST");
        expect(capturedRequest!.headers.get("Content-Type")).toBe("application/zip");
        expect(capturedRequest!.headers.get("X-Custom-Header")).toBe("custom-value");
        expect(capturedRequest!.headers.get("Authorization")).toBe("Bearer test");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});
