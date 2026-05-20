/**
 * Unit tests for egress-core package
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import { EgressRegistry, hostnameMatchesDomain, type EgressHandler, type EgressContext } from "../src/index.js";

describe("egress-core", () => {
  describe("EgressRegistry", () => {
    it("should register and retrieve handlers", () => {
      const registry = new EgressRegistry();
      const handler: EgressHandler = {
        name: "test-handler",
        description: "Test handler",
        domains: ["example.com"],
        handles: () => true,
      };

      registry.register(handler);
      const retrieved = registry.get("test-handler");

      assert.strictEqual(retrieved, handler);
    });

    it("should return undefined for non-existent handler", () => {
      const registry = new EgressRegistry();
      const retrieved = registry.get("non-existent");

      assert.strictEqual(retrieved, undefined);
    });

    it("should list all registered handlers", () => {
      const registry = new EgressRegistry();
      const handler1: EgressHandler = {
        name: "handler-1",
        description: "Handler 1",
        domains: ["example1.com"],
        handles: () => true,
      };
      const handler2: EgressHandler = {
        name: "handler-2",
        description: "Handler 2",
        domains: ["example2.com"],
        handles: () => false,
      };

      registry.register(handler1);
      registry.register(handler2);
      const handlers = registry.list();

      assert.strictEqual(handlers.length, 2);
      assert(handlers.includes(handler1));
      assert(handlers.includes(handler2));
    });

    it("should overwrite handler with same name", () => {
      const registry = new EgressRegistry();
      const handler1: EgressHandler = {
        name: "same-name",
        description: "First",
        domains: ["example.com"],
        handles: () => true,
      };
      const handler2: EgressHandler = {
        name: "same-name",
        description: "Second",
        domains: ["example.org"],
        handles: () => false,
      };

      registry.register(handler1);
      registry.register(handler2);
      const retrieved = registry.get("same-name");

      assert.strictEqual(retrieved, handler2);
      assert.strictEqual(registry.list().length, 1);
    });
  });

  describe("hostnameMatchesDomain", () => {
    it("should match exact hostname", () => {
      assert.strictEqual(hostnameMatchesDomain("api.github.com", "api.github.com"), true);
    });

    it("should match subdomain", () => {
      assert.strictEqual(hostnameMatchesDomain("v1.api.github.com", "api.github.com"), true);
    });

    it("should not match different domain", () => {
      assert.strictEqual(hostnameMatchesDomain("github.com", "api.github.com"), false);
    });

    it("should not match suffix that is not a subdomain", () => {
      assert.strictEqual(hostnameMatchesDomain("notgithub.com", "github.com"), false);
    });

    it("should be case-insensitive", () => {
      assert.strictEqual(hostnameMatchesDomain("API.GITHUB.COM", "api.github.com"), true);
      assert.strictEqual(hostnameMatchesDomain("api.github.com", "API.GITHUB.COM"), true);
    });

    it("should handle complex subdomains", () => {
      assert.strictEqual(hostnameMatchesDomain("raw.githubusercontent.com", "githubusercontent.com"), true);
      assert.strictEqual(hostnameMatchesDomain("user.repo.github.com", "github.com"), true);
    });
  });

  describe("EgressHandler interface", () => {
    it("should support fetch method", async () => {
      const handler: EgressHandler<{ TOKEN: string }> = {
        name: "fetch-handler",
        description: "Handler with fetch",
        domains: ["api.example.com"],
        handles: (_req: Request, _ctx: EgressContext<{ TOKEN: string }>) => true,
        fetch: async (_req: Request, ctx: EgressContext<{ TOKEN: string }>) => {
          return new Response(JSON.stringify({ token: ctx.env.TOKEN }));
        },
      };

      const request = new Request("https://api.example.com/data");
      const context: EgressContext<{ TOKEN: string }> = { env: { TOKEN: "secret123" } };

      assert.strictEqual(await handler.handles(request, context), true);
      const response = await handler.fetch!(request, context);
      const data = await response.json() as { token: string };
      assert.strictEqual(data.token, "secret123");
    });

    it("should support optional connect method", () => {
      const handler: EgressHandler = {
        name: "websocket-handler",
        description: "Handler with connect",
        domains: ["ws.example.com"],
        handles: () => true,
        connect: (_socket: unknown) => {
          // WebSocket connection logic
        },
      };

      assert.strictEqual(typeof handler.connect, "function");
    });

    it("should work with minimal implementation (handles only)", async () => {
      const handler: EgressHandler = {
        name: "minimal",
        description: "Minimal handler",
        domains: ["example.com"],
        handles: () => true,
      };

      assert.strictEqual(typeof handler.fetch, "undefined");
      assert.strictEqual(typeof handler.connect, "undefined");
      assert.strictEqual(await handler.handles(new Request("https://example.com"), {} as EgressContext), true);
    });
  });
});
