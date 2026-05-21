import { describe, expect, it } from "vitest";
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

function createContext() {
  return { env };
}

async function fetchThroughGithubEgress(url: string, init?: RequestInit): Promise<Response> {
  const request = new Request(url, init);
  expect(githubHandler.handles(request, createContext())).toBe(true);
  return githubHandler.fetch!(request, createContext());
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
