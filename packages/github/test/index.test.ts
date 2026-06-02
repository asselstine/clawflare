/**
 * Unit tests for GitHub egress handler
 */
import { describe, it, expect, vi } from "vitest";
import {
  classifyGithubRequest,
  decorateGithubHeaders,
  registerEgressHandlers,
} from "../src/index.js";
import { EgressRegistry, type EgressContext } from "@clawflare/egress-core";

describe("github egress handler", () => {
  interface MockEnv {
    GITHUB_TOKEN?: string;
    GITHUB_USERNAME?: string;
    GITHUB_SMART_HTTP_EGRESS?: string;
    MOCK_AI?: string;
  }

  const createRegistry = () => new EgressRegistry<MockEnv>();
  const createContext = (env: MockEnv): EgressContext<MockEnv> => ({ env });

  async function captureFetchRequest(request: Request, env: MockEnv = {}): Promise<Request> {
    const registry = createRegistry();
    registerEgressHandlers(registry);
    const handler = registry.get("github")!;

    const originalFetch = globalThis.fetch;
    let capturedRequest: Request | undefined;
    globalThis.fetch = vi.fn((req: Parameters<typeof fetch>[0]) => {
      capturedRequest = req as Request;
      return Promise.resolve(new Response(JSON.stringify({ success: true })));
    }) as typeof globalThis.fetch;

    try {
      await handler.fetch!(request, createContext(env));
      expect(capturedRequest).toBeDefined();
      return capturedRequest!;
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

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
        "codeload.github.com",
      ]);
    });
  });

  describe("fetch context", () => {
    it("does not throw when called without an egress context", async () => {
      const registry = createRegistry();
      registerEgressHandlers(registry);
      const handler = registry.get("github")!;

      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify({ login: "octocat" })))
      ) as typeof globalThis.fetch;

      try {
        const response = await handler.fetch!(
          new Request("https://api.github.com/user"),
          undefined as unknown as EgressContext<MockEnv>
        );
        expect(response.status).toBe(200);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe("classification", () => {
    it.each([
      ["https://api.github.com/repos/owner/repo", "api"],
      ["https://raw.githubusercontent.com/owner/repo/main/a.ts", "raw"],
      ["https://codeload.github.com/owner/repo/tar.gz/main", "archive"],
      ["https://github.com/owner/repo/archive/refs/heads/main.tar.gz", "archive"],
      ["https://github.com/owner/repo", "web"],
      ["https://github.com/owner/repo.git", "git-smart-http"],
      ["https://github.com/owner/repo.git/info/refs?service=git-upload-pack", "git-smart-http"],
      ["https://github.com/owner/repo.git/git-upload-pack", "git-smart-http"],
    ] as const)("classifies %s as %s", (url, kind) => {
      expect(classifyGithubRequest(new Request(url))).toBe(kind);
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

    it("should handle codeload.github.com", () => {
      const registry = createRegistry();
      registerEgressHandlers(registry);
      const handler = registry.get("github")!;

      expect(handler.handles(new Request("https://codeload.github.com/user/repo/tar.gz/main"), createContext({}))).toBe(true);
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

    it("should add Authorization header when GITHUB_TOKEN is set for API requests", async () => {
      const capturedRequest = await captureFetchRequest(
        new Request("https://api.github.com/user"),
        { GITHUB_TOKEN: "ghp_secret123" }
      );

      expect(capturedRequest.headers.get("Authorization")).toBe("Bearer ghp_secret123");
    });

    it("should add default Accept header for API requests", async () => {
      const capturedRequest = await captureFetchRequest(new Request("https://api.github.com/user"));

      expect(capturedRequest.headers.get("Accept")).toBe("application/vnd.github+json");
    });

    it("should add default API version header for API requests", async () => {
      const capturedRequest = await captureFetchRequest(new Request("https://api.github.com/user"));

      expect(capturedRequest.headers.get("X-GitHub-Api-Version")).toBe("2022-11-28");
    });

    it("should add default User-Agent header for API requests", async () => {
      const capturedRequest = await captureFetchRequest(new Request("https://api.github.com/user"));

      expect(capturedRequest.headers.get("User-Agent")).toBe("Clawflare-Agent");
    });

    it("should preserve existing API request headers", async () => {
      const capturedRequest = await captureFetchRequest(new Request("https://api.github.com/user", {
        headers: {
          "Accept": "application/vnd.github.v3+json",
          "User-Agent": "Existing-Agent",
          "X-Custom-Header": "custom-value",
        },
      }));

      expect(capturedRequest.headers.get("Accept")).toBe("application/vnd.github.v3+json");
      expect(capturedRequest.headers.get("User-Agent")).toBe("Existing-Agent");
      expect(capturedRequest.headers.get("X-Custom-Header")).toBe("custom-value");
    });

    it.each([
      "https://raw.githubusercontent.com/user/repo/main/README.md",
      "https://codeload.github.com/user/repo/tar.gz/main",
      "https://github.com/owner/repo/archive/refs/heads/main.tar.gz",
      "https://github.com/owner/repo",
    ])("should not add REST API headers to %s", async (url) => {
      const capturedRequest = await captureFetchRequest(new Request(url));

      expect(capturedRequest.headers.get("Accept")).not.toBe("application/vnd.github+json");
      expect(capturedRequest.headers.get("User-Agent")).toBe("Clawflare-Agent");
      expect(capturedRequest.headers.get("X-GitHub-Api-Version")).toBeNull();
    });

    it("should pass through native git smart HTTP by default without REST API headers", async () => {
      const capturedRequest = await captureFetchRequest(new Request(
        "https://github.com/owner/repo.git/info/refs?service=git-upload-pack",
        { headers: { Accept: "application/x-git-upload-pack-advertisement" } }
      ));

      expect(capturedRequest.headers.get("Accept")).toBe("application/x-git-upload-pack-advertisement");
      expect(capturedRequest.headers.get("User-Agent")).toBeNull();
      expect(capturedRequest.headers.get("X-GitHub-Api-Version")).toBeNull();
    });

    it("should add Basic auth for native git smart HTTP clone and fetch requests", async () => {
      const capturedRequest = await captureFetchRequest(
        new Request(
          "https://github.com/owner/repo.git/info/refs?service=git-upload-pack",
          { headers: { Accept: "application/x-git-upload-pack-advertisement" } }
        ),
        { GITHUB_USERNAME: "octocat", GITHUB_TOKEN: "ghp_secret123" }
      );

      expect(capturedRequest.headers.get("Authorization")).toBe(`Basic ${btoa("octocat:ghp_secret123")}`);
      expect(capturedRequest.headers.get("X-GitHub-Api-Version")).toBeNull();
    });

    it("should add Basic auth for native git smart HTTP push requests", async () => {
      const capturedRequest = await captureFetchRequest(
        new Request(
          "https://github.com/owner/repo.git/git-receive-pack",
          {
            method: "POST",
            headers: { Accept: "application/x-git-receive-pack-result" },
          }
        ),
        { GITHUB_USERNAME: "octocat", GITHUB_TOKEN: "ghp_secret123" }
      );

      expect(capturedRequest.headers.get("Authorization")).toBe(`Basic ${btoa("octocat:ghp_secret123")}`);
    });

    it("should override client-provided Authorization for native git smart HTTP", async () => {
      const capturedRequest = await captureFetchRequest(
        new Request(
          "https://github.com/owner/repo.git/git-upload-pack",
          {
            method: "POST",
            headers: {
              Accept: "application/x-git-upload-pack-result",
              Authorization: "Basic d3Jvbmc6Y3JlZGVudGlhbHM=",
            },
          }
        ),
        { GITHUB_USERNAME: "octocat", GITHUB_TOKEN: "ghp_secret123" }
      );

      expect(capturedRequest.headers.get("Authorization")).toBe(`Basic ${btoa("octocat:ghp_secret123")}`);
    });

    it("should remove client-provided Authorization from native git smart HTTP when configured credentials are incomplete", async () => {
      const capturedRequest = await captureFetchRequest(
        new Request(
          "https://github.com/owner/repo.git/git-upload-pack",
          {
            method: "POST",
            headers: {
              Accept: "application/x-git-upload-pack-result",
              Authorization: "Basic d3Jvbmc6Y3JlZGVudGlhbHM=",
            },
          }
        ),
        { GITHUB_TOKEN: "ghp_secret123" }
      );

      expect(capturedRequest.headers.get("Authorization")).toBeNull();
    });

    it("should remove browser-only headers from native git smart HTTP", async () => {
      const capturedRequest = await captureFetchRequest(new Request(
        "https://github.com/owner/repo.git/git-upload-pack",
        {
          method: "POST",
          headers: {
            Accept: "application/x-git-upload-pack-result",
            Origin: "https://example.com",
            Referer: "https://example.com/",
            "Sec-Fetch-Dest": "empty",
            "Sec-Fetch-Mode": "cors",
            "Sec-Fetch-Site": "cross-site",
            "Sec-Fetch-User": "?1",
            "X-GitHub-Api-Version": "2022-11-28",
          },
        }
      ));

      expect(capturedRequest.headers.get("Accept")).toBe("application/x-git-upload-pack-result");
      expect(capturedRequest.headers.get("Origin")).toBeNull();
      expect(capturedRequest.headers.get("Referer")).toBeNull();
      expect(capturedRequest.headers.get("Sec-Fetch-Dest")).toBeNull();
      expect(capturedRequest.headers.get("Sec-Fetch-Mode")).toBeNull();
      expect(capturedRequest.headers.get("Sec-Fetch-Site")).toBeNull();
      expect(capturedRequest.headers.get("Sec-Fetch-User")).toBeNull();
      expect(capturedRequest.headers.get("X-GitHub-Api-Version")).toBeNull();
    });

    it("should block native git smart HTTP when disabled", async () => {
      const registry = createRegistry();
      registerEgressHandlers(registry);
      const handler = registry.get("github")!;

      const response = await handler.fetch!(
        new Request("https://github.com/owner/repo.git/info/refs?service=git-upload-pack"),
        createContext({ GITHUB_SMART_HTTP_EGRESS: "disabled" })
      );

      expect(response.status).toBe(501);
      expect(response.headers.get("X-Clawflare-Egress-Kind")).toBe("git-smart-http");
      await expect(response.text()).resolves.toContain("Native Git smart-HTTP is disabled");
    });
  });

  describe("decorateGithubHeaders", () => {
    it("only adds User-Agent for raw traffic", () => {
      const headers = new Headers();

      decorateGithubHeaders(
        headers,
        new Request("https://raw.githubusercontent.com/owner/repo/main/file.txt"),
        createContext({ GITHUB_TOKEN: "secret" })
      );

      expect(headers.get("User-Agent")).toBe("Clawflare-Agent");
      expect(headers.get("Accept")).toBeNull();
      expect(headers.get("Authorization")).toBeNull();
      expect(headers.get("X-GitHub-Api-Version")).toBeNull();
    });
  });
});
