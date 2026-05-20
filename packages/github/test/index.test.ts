/**
 * Unit tests for GitHub egress handler
 */
import { describe, it, expect, vi } from "vitest";
import { registerEgressHandlers } from "../src/index.js";
import { EgressRegistry, type EgressContext } from "@clawflare/egress-core";

describe("github egress handler", () => {
  interface MockEnv {
    GITHUB_TOKEN?: string;
    MOCK_AI?: string;
  }

  const createRegistry = () => new EgressRegistry<MockEnv>();
  const createContext = (env: MockEnv): EgressContext<MockEnv> => ({ env });

  describe("registration", () => {
    it("should register the github handler", () => {
      const registry = createRegistry();
      registerEgressHandlers(registry);

      const handler = registry.get("github");
      expect(handler).toBeDefined();
      expect(handler?.name).toBe("github");
      expect(handler?.description?.startsWith("GitHub API and content access")).toBe(true);
    });

    it("should register with correct domains", () => {
      const registry = createRegistry();
      registerEgressHandlers(registry);

      const handler = registry.get("github");
      expect(handler).toBeDefined();
      expect(handler?.domains).toEqual([
        "api.github.com",
        "github.com",
        "raw.githubusercontent.com",
      ]);
    });
  });

  describe("handles", () => {
    it("should handle api.github.com", () => {
      const registry = createRegistry();
      registerEgressHandlers(registry);
      const handler = registry.get("github")!;

      expect(handler.handles(new Request("https://api.github.com/user"), createContext({}))).toBe(true);
    });

    it("should handle github.com", () => {
      const registry = createRegistry();
      registerEgressHandlers(registry);
      const handler = registry.get("github")!;

      expect(handler.handles(new Request("https://github.com/octocat"), createContext({}))).toBe(true);
    });

    it("should handle raw.githubusercontent.com", () => {
      const registry = createRegistry();
      registerEgressHandlers(registry);
      const handler = registry.get("github")!;

      expect(
        handler.handles(new Request("https://raw.githubusercontent.com/user/repo/main/README.md"), createContext({}))
      ).toBe(true);
    });

    it("should not handle non-github domains", () => {
      const registry = createRegistry();
      registerEgressHandlers(registry);
      const handler = registry.get("github")!;

      expect(handler.handles(new Request("https://example.com"), createContext({}))).toBe(false);
      expect(handler.handles(new Request("https://gitlab.com"), createContext({}))).toBe(false);
      expect(handler.handles(new Request("https://bitbucket.org"), createContext({}))).toBe(false);
    });

    it("should handle subdomains of github.com", () => {
      const registry = createRegistry();
      registerEgressHandlers(registry);
      const handler = registry.get("github")!;

      expect(handler.handles(new Request("https://gist.github.com"), createContext({}))).toBe(true);
    });
  });

  describe("fetch", () => {
    it("should return mock response in mock mode", async () => {
      const registry = createRegistry();
      registerEgressHandlers(registry);
      const handler = registry.get("github")!;

      const request = new Request("https://api.github.com/user");
      const context = createContext({ MOCK_AI: "true" });

      const response = await handler.fetch!(request, context);
      const data = await response.json() as { ok: boolean; handler: string; url: string };

      expect(data.ok).toBe(true);
      expect(data.handler).toBe("github");
      expect(data.url).toBe("https://api.github.com/user");
    });

    it("should add Authorization header when GITHUB_TOKEN is set", async () => {
      const registry = createRegistry();
      registerEgressHandlers(registry);
      const handler = registry.get("github")!;

      const request = new Request("https://api.github.com/user");
      const context = createContext({ GITHUB_TOKEN: "ghp_secret123" });

      // Mock fetch by creating a custom response
      const originalFetch = globalThis.fetch;
      let capturedRequest: Request | undefined;
      globalThis.fetch = vi.fn((req: Parameters<typeof fetch>[0]) => {
        capturedRequest = req as Request;
        return Promise.resolve(new Response(JSON.stringify({ success: true })));
      }) as typeof globalThis.fetch;

      try {
        await handler.fetch!(request, context);
        expect(capturedRequest).toBeDefined();
        expect(capturedRequest!.headers.get("Authorization")).toBe("Bearer ghp_secret123");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("should add default Accept header", async () => {
      const registry = createRegistry();
      registerEgressHandlers(registry);
      const handler = registry.get("github")!;

      const request = new Request("https://api.github.com/user");
      const context = createContext({});

      const originalFetch = globalThis.fetch;
      let capturedRequest: Request | undefined;
      globalThis.fetch = vi.fn((req: Parameters<typeof fetch>[0]) => {
        capturedRequest = req as Request;
        return Promise.resolve(new Response(JSON.stringify({ success: true })));
      }) as typeof globalThis.fetch;

      try {
        await handler.fetch!(request, context);
        expect(
          capturedRequest!.headers.get("Accept")
        ).toBe("application/vnd.github+json");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("should add default API version header", async () => {
      const registry = createRegistry();
      registerEgressHandlers(registry);
      const handler = registry.get("github")!;

      const request = new Request("https://api.github.com/user");
      const context = createContext({});

      const originalFetch = globalThis.fetch;
      let capturedRequest: Request | undefined;
      globalThis.fetch = vi.fn((req: Parameters<typeof fetch>[0]) => {
        capturedRequest = req as Request;
        return Promise.resolve(new Response(JSON.stringify({ success: true })));
      }) as typeof globalThis.fetch;

      try {
        await handler.fetch!(request, context);
        expect(capturedRequest!.headers.get("X-GitHub-Api-Version")).toBe("2022-11-28");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("should preserve existing headers", async () => {
      const registry = createRegistry();
      registerEgressHandlers(registry);
      const handler = registry.get("github")!;

      const request = new Request("https://api.github.com/user", {
        headers: {
          "Accept": "application/vnd.github.v3+json",
          "X-Custom-Header": "custom-value",
        },
      });
      const context = createContext({});

      const originalFetch = globalThis.fetch;
      let capturedRequest: Request | undefined;
      globalThis.fetch = vi.fn((req: Parameters<typeof fetch>[0]) => {
        capturedRequest = req as Request;
        return Promise.resolve(new Response(JSON.stringify({ success: true })));
      }) as typeof globalThis.fetch;

      try {
        await handler.fetch!(request, context);
        expect(
          capturedRequest!.headers.get("Accept")
        ).toBe("application/vnd.github.v3+json");
        expect(capturedRequest!.headers.get("X-Custom-Header")).toBe("custom-value");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});
