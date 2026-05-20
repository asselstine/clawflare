import { defineHttpEgressHandler, type HttpEgressHandlerContext } from "@clawflare/egress-core";

export const domains = ["api.github.com", "github.com", "raw.githubusercontent.com"];

export const metadata = {
  name: "github",
  description:
    "GitHub API and content access - automatically injects Authorization: Bearer token and API version headers when GITHUB_TOKEN is configured",
  domains,
} as const;

interface GithubEnv {
  GITHUB_TOKEN?: string;
  MOCK_AI?: string;
}

export const githubHandler = defineHttpEgressHandler<GithubEnv>({
  name: metadata.name,
  description: metadata.description,
  domains,

  async decorateHeaders(headers, context: HttpEgressHandlerContext<GithubEnv>): Promise<void> {
    headers.set("Accept", headers.get("Accept") || "application/vnd.github+json");
    headers.set("X-GitHub-Api-Version", headers.get("X-GitHub-Api-Version") || "2022-11-28");

    if (context.env.GITHUB_TOKEN) {
      headers.set("Authorization", `Bearer ${context.env.GITHUB_TOKEN}`);
    }
  },
});

export function registerEgressHandlers(registry: { register: (handler: typeof githubHandler) => void }): void {
  registry.register(githubHandler);
}
