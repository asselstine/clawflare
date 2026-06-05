import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { EgressLogger } from "@clawflare/egress-core";
import { githubHandler } from "../src/index.js";

interface GithubRepoResponse {
  default_branch: string;
  full_name: string;
  private: boolean;
}

const owner = "asselstine";
const repo = "clawflare";
const fullName = `${owner}/${repo}`;
const env = {
  GITHUB_TOKEN: process.env.GITHUB_TOKEN,
};
const logger: EgressLogger = {
  info: () => {},
  warn: () => {},
};

function createContext() {
  return { env, logger };
}

async function fetchThroughGithubEgress(url: string, init?: RequestInit): Promise<Response> {
  const request = new Request(url, init);
  expect(githubHandler.handles(request, createContext())).toBe(true);
  return githubHandler.fetch!(request, createContext());
}

interface GithubProxyServer {
  baseUrl: string;
  close: () => Promise<void>;
  errors: string[];
}

interface CommandResult {
  code: number | null;
  output: string;
}

const hopByHopHeaders = new Set([
  "connection",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function headersFromIncoming(headers: IncomingHttpHeaders): Headers {
  const result = new Headers();

  for (const [name, value] of Object.entries(headers)) {
    if (hopByHopHeaders.has(name.toLowerCase())) continue;
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) result.append(name, item);
    } else {
      result.set(name, value);
    }
  }

  return result;
}

async function createGithubHandlerProxy(): Promise<GithubProxyServer> {
  const errors: string[] = [];
  const server = createServer(async (incomingRequest, outgoingResponse) => {
    try {
      const target = new URL(incomingRequest.url ?? "/", `https://github.com`);
      const method = incomingRequest.method ?? "GET";
      const hasBody = method !== "GET" && method !== "HEAD";
      const request = new Request(target, {
        method,
        headers: headersFromIncoming(incomingRequest.headers),
        body: hasBody ? Readable.toWeb(incomingRequest) as ReadableStream<Uint8Array> : undefined,
        duplex: hasBody ? "half" : undefined,
      } as RequestInit & { duplex?: "half" });

      const response = await githubHandler.fetch!(request, {
        ...createContext(),
        requestId: `git-proxy:${method}:${target.pathname}`,
      });

      outgoingResponse.writeHead(response.status, response.statusText, Object.fromEntries(response.headers));
      if (response.body) {
        Readable.fromWeb(response.body).pipe(outgoingResponse);
      } else {
        outgoingResponse.end();
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.stack ?? error.message : String(error));
      outgoingResponse.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
      outgoingResponse.end(error instanceof Error ? error.stack ?? error.message : String(error));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (typeof address !== "object" || address === null) {
    await closeServer(server);
    throw new Error("GitHub handler proxy did not bind to a TCP port");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => closeServer(server),
    errors,
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function runGit(args: string[], cwd?: string): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      env: {
        ...process.env,
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "http.version",
        GIT_CONFIG_VALUE_0: "HTTP/1.1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, output }));
  });
}

function expectGitSuccess(result: CommandResult, proxy?: GithubProxyServer): void {
  expect(result.output).not.toContain("GnuTLS recv error");
  expect(result.output).not.toContain("TLS connection was non-properly terminated");
  const proxyErrors = proxy?.errors.length ? `\nProxy errors:\n${proxy.errors.join("\n\n")}` : "";
  expect(result.code, `${result.output}${proxyErrors}`).toBe(0);
}

async function expectOk(response: Response): Promise<void> {
  if (response.ok) return;

  const body = await response.text();
  throw new Error(
    `Expected GitHub response to be ok, got ${response.status} ${response.statusText}: ${body.slice(0, 500)}`
  );
}

let repoMetadataPromise: Promise<GithubRepoResponse> | undefined;

async function getRepoMetadata(): Promise<GithubRepoResponse> {
  repoMetadataPromise ??= (async () => {
    const response = await fetchThroughGithubEgress(`https://api.github.com/repos/${fullName}`);
    await expectOk(response);

    expect(response.headers.get("X-Clawflare-Egress-Handler")).toBe("github");
    expect(response.headers.get("X-Clawflare-Egress-Kind")).toBe("api");

    const data = await response.json() as GithubRepoResponse;
    expect(data.full_name).toBe(fullName);
    expect(data.private).toBe(false);
    expect(data.default_branch).toMatch(/\S/);
    return data;
  })();

  return repoMetadataPromise;
}

describe("github egress handler integration", () => {
  it("fetches repository metadata through the API path", async () => {
    await getRepoMetadata();
  }, 20_000);

  it("fetches raw repository content", async () => {
    const metadata = await getRepoMetadata();
    const response = await fetchThroughGithubEgress(
      `https://raw.githubusercontent.com/${fullName}/${metadata.default_branch}/README.md`
    );
    await expectOk(response);

    expect(response.headers.get("X-Clawflare-Egress-Handler")).toBe("github");
    expect(response.headers.get("X-Clawflare-Egress-Kind")).toBe("raw");

    const text = await response.text();
    expect(text).toContain("Clawflare");
  }, 20_000);

  it("fetches a Git smart-HTTP advertisement for clone/ls-remote", async () => {
    const response = await fetchThroughGithubEgress(
      `https://github.com/${fullName}.git/info/refs?service=git-upload-pack`,
      {
        headers: {
          Accept: "application/x-git-upload-pack-advertisement",
          Origin: "https://example.com",
        },
      }
    );
    await expectOk(response);

    expect(response.headers.get("X-Clawflare-Egress-Handler")).toBe("github");
    expect(response.headers.get("X-Clawflare-Egress-Kind")).toBe("git-smart-http");
    expect(response.headers.get("Content-Type")).toContain("application/x-git-upload-pack-advertisement");

    const text = await response.text();
    expect(text).toContain("# service=git-upload-pack");
  }, 20_000);

  it("sanitizes Git smart-HTTP proxy framing headers", async () => {
    let outboundRequest: Request | undefined;
    const fetchMock = vi.fn(async (request: Request) => {
      outboundRequest = request;
      return new Response("001e# service=git-upload-pack\n0000", {
        headers: {
          "Connection": "close",
          "Content-Length": "9999",
          "Content-Type": "application/x-git-upload-pack-advertisement",
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const response = await fetchThroughGithubEgress(
        `https://github.com/${fullName}.git/info/refs?service=git-upload-pack`,
        {
          headers: {
            "Accept-Encoding": "gzip, deflate, br",
          },
        }
      );

      expect(fetchMock).toHaveBeenCalledOnce();
      expect(outboundRequest?.headers.get("Accept-Encoding")).toBe("identity");
      expect(response.headers.get("Connection")).toBeNull();
      expect(response.headers.get("Content-Length")).toBeNull();
      expect(response.headers.get("X-Clawflare-Egress-Kind")).toBe("git-smart-http");
      await expect(response.text()).resolves.toContain("# service=git-upload-pack");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("runs git ls-remote through the GitHub egress proxy path", async () => {
    const proxy = await createGithubHandlerProxy();
    try {
      const result = await runGit(["ls-remote", `${proxy.baseUrl}/${fullName}.git`, "HEAD"]);
      expectGitSuccess(result, proxy);
      expect(result.output).toMatch(/^[0-9a-f]{40}\s+HEAD/m);
    } finally {
      await proxy.close();
    }
  }, 30_000);

  it("runs a shallow git clone through the GitHub egress proxy path", async () => {
    const proxy = await createGithubHandlerProxy();
    const dir = await mkdtemp(join(tmpdir(), "clawflare-github-egress-"));
    try {
      const result = await runGit([
        "clone",
        "--depth=1",
        "--single-branch",
        `${proxy.baseUrl}/${fullName}.git`,
        "repo",
      ], dir);
      expectGitSuccess(result, proxy);

      const head = await runGit(["rev-parse", "--verify", "HEAD"], join(dir, "repo"));
      expectGitSuccess(head);
      expect(head.output).toMatch(/^[0-9a-f]{40}/);
    } finally {
      await proxy.close();
      await rm(dir, { force: true, recursive: true });
    }
  }, 60_000);

  it("fetches a GitHub web archive URL as archive traffic", async () => {
    const metadata = await getRepoMetadata();
    const response = await fetchThroughGithubEgress(
      `https://github.com/${fullName}/archive/refs/heads/${metadata.default_branch}.tar.gz`
    );
    await expectOk(response);

    expect(response.headers.get("X-Clawflare-Egress-Handler")).toBe("github");
    expect(response.headers.get("X-Clawflare-Egress-Kind")).toBe("archive");

    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    const chunk = await reader!.read();
    await reader!.cancel();

    expect(chunk.value?.[0]).toBe(0x1f);
    expect(chunk.value?.[1]).toBe(0x8b);
  }, 30_000);

  it("fetches a GitHub web page without API headers", async () => {
    const response = await fetchThroughGithubEgress(`https://github.com/${fullName}`);
    await expectOk(response);

    expect(response.headers.get("X-Clawflare-Egress-Handler")).toBe("github");
    expect(response.headers.get("X-Clawflare-Egress-Kind")).toBe("web");

    const text = await response.text();
    expect(text).toContain(fullName);
  }, 20_000);
});
