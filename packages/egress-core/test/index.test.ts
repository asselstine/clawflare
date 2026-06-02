/**
 * Unit tests for egress-core package
 */
import { describe, it, expect } from "vitest";
import { EgressRegistry, hostnameMatchesDomain, type EgressHandler, type EgressContext, type EgressLogger } from "../src/index.js";

const logger: EgressLogger = {
  info: () => {},
  warn: () => {},
};

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

      expect(retrieved).toBe(handler);
    });

    it("should return undefined for non-existent handler", () => {
      const registry = new EgressRegistry();
      const retrieved = registry.get("non-existent");

      expect(retrieved).toBeUndefined();
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

      expect(handlers.length).toBe(2);
      expect(handlers).toContain(handler1);
      expect(handlers).toContain(handler2);
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

      expect(retrieved).toBe(handler2);
      expect(registry.list().length).toBe(1);
    });
  });

  describe("hostnameMatchesDomain", () => {
    it("should match exact hostname", () => {
      expect(hostnameMatchesDomain("api.github.com", "api.github.com")).toBe(true);
    });

    it("should match subdomain", () => {
      expect(hostnameMatchesDomain("v1.api.github.com", "api.github.com")).toBe(true);
    });

    it("should not match different domain", () => {
      expect(hostnameMatchesDomain("github.com", "api.github.com")).toBe(false);
    });

    it("should not match suffix that is not a subdomain", () => {
      expect(hostnameMatchesDomain("notgithub.com", "github.com")).toBe(false);
    });

    it("should be case-insensitive", () => {
      expect(hostnameMatchesDomain("API.GITHUB.COM", "api.github.com")).toBe(true);
      expect(hostnameMatchesDomain("api.github.com", "API.GITHUB.COM")).toBe(true);
    });

    it("should handle complex subdomains", () => {
      expect(hostnameMatchesDomain("raw.githubusercontent.com", "githubusercontent.com")).toBe(true);
      expect(hostnameMatchesDomain("user.repo.github.com", "github.com")).toBe(true);
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
      const context: EgressContext<{ TOKEN: string }> = { env: { TOKEN: "secret123" }, logger };

      expect(await handler.handles(request, context)).toBe(true);
      const response = await handler.fetch!(request, context);
      const data = await response.json() as { token: string };
      expect(data.token).toBe("secret123");
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

      expect(typeof handler.connect).toBe("function");
    });

    it("should work with minimal implementation (handles only)", async () => {
      const handler: EgressHandler = {
        name: "minimal",
        description: "Minimal handler",
        domains: ["example.com"],
        handles: () => true,
      };

      expect(typeof handler.fetch).toBe("undefined");
      expect(typeof handler.connect).toBe("undefined");
      expect(await handler.handles(new Request("https://example.com"), { env: {}, logger })).toBe(true);
    });
  });
});
