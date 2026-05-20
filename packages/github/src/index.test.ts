/**
 * Unit tests for GitHub egress handler
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import { registerEgressHandlers } from "./index.js";
import { EgressRegistry, hostnameMatchesDomain, type EgressContext } from "@clawflare/egress-core";

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
      assert.ok(handler);
      assert.strictEqual(handler.name, "github");
      assert.strictEqual(handler.description, "GitHub API and content access");
    });

    it("should register with correct domains", () => {
      const registry = createRegistry();
      registerEgressHandlers(registry);

      const handler = registry.get("github");
      assert.ok(handler);
      assert.deepStrictEqual(handler.domains, [
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

      assert.strictEqual(handler.handles(new Request("https://api.github.com/user"), createContext({})), true);
    });

    it("should handle github.com", () => {
      const registry = createRegistry();
      registerEgressHandlers(registry);
      const handler = registry.get("github")!;

      assert.strictEqual(handler.handles(new Request("https://github.com/octocat"), createContext({})), true);
    });

    it("should handle raw.githubusercontent.com", () => {
      const registry = createRegistry();
      registerEgressHandlers(registry);
      const handler = registry.get("github")!;

      assert.strictEqual(
        handler.handles(new Request("https://raw.githubusercontent.com/user/repo/main/README.md"), createContext({})),
        true
      );
    });

    it("should not handle non-github domains", () => {
      const registry = createRegistry();
      registerEgressHandlers(registry);
      const handler = registry.get("github")!;

      assert.strictEqual(handler.handles(new Request("https://example.com"), createContext({})), false);
      assert.strictEqual(handler.handles(new Request("https://gitlab.com"), createContext({})), false);
      assert.strictEqual(handler.handles(new Request("https://bitbucket.org"), createContext({})), false);
    });

    it("should handle subdomains of github.com", () => {
      const registry = createRegistry();
      registerEgressHandlers(registry);
      const handler = registry.get("github")!;

      assert.strictEqual(handler.handles(new Request("https://gist.github.com"), createContext({})), true);
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
      const data = await response.json();

      assert.strictEqual(data.ok, true);
      assert.strictEqual(data.handler, "github");
      assert.strictEqual(data.url, "https://api.github.com/user");
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
      globalThis.fetch = (req: RequestInfo | URL) => {
        capturedRequest = req as Request;
        return Promise.resolve(new Response(JSON.stringify({ success: true })));
      };

      try {
        await handler.fetch!(request, context);
        assert.ok(capturedRequest);
        assert.strictEqual(capturedRequest!.headers.get("Authorization"), "Bearer ghp_secret123");
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
      globalThis.fetch = (req: RequestInfo | URL) => {
        capturedRequest = req as Request;
        return Promise.resolve(new Response(JSON.stringify({ success: true })));
      };

      try {
        await handler.fetch!(request, context);
        assert.strictEqual(
          capturedRequest!.headers.get("Accept"),
          "application/vnd.github+json"
        );
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
      globalThis.fetch = (req: RequestInfo | URL) => {
        capturedRequest = req as Request;
        return Promise.resolve(new Response(JSON.stringify({ success: true })));
      };

      try {
        await handler.fetch!(request, context);
        assert.strictEqual(capturedRequest!.headers.get("X-GitHub-Api-Version"), "2022-11-28");
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
      globalThis.fetch = (req: RequestInfo | URL) => {
        capturedRequest = req as Request;
        return Promise.resolve(new Response(JSON.stringify({ success: true })));
      };

      try {
        await handler.fetch!(request, context);
        assert.strictEqual(
          capturedRequest!.headers.get("Accept"),
          "application/vnd.github.v3+json"
        );
        assert.strictEqual(capturedRequest!.headers.get("X-Custom-Header"), "custom-value");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});
