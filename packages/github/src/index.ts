import { hostnameMatchesDomain, type EgressContext, type EgressHandler, type EgressRegistry } from "@clawflare/egress-core";

interface GithubEnv {
  GITHUB_TOKEN?: string;
  MOCK_AI?: string;
}

const domains = ["api.github.com", "github.com", "raw.githubusercontent.com"];

const githubHandler: EgressHandler<GithubEnv> = {
  name: "github",
  description: "GitHub API and content access",
  domains,

  handles(request: Request): boolean {
    const hostname = new URL(request.url).hostname;
    return domains.some((domain) => hostnameMatchesDomain(hostname, domain));
  },

  async fetch(request: Request, context: EgressContext<GithubEnv>): Promise<Response> {
    if (context.env.MOCK_AI === "true") {
      return Response.json({ ok: true, handler: "github", url: request.url });
    }

    const headers = new Headers(request.headers);
    headers.set("Accept", headers.get("Accept") || "application/vnd.github+json");
    headers.set("X-GitHub-Api-Version", headers.get("X-GitHub-Api-Version") || "2022-11-28");

    if (context.env.GITHUB_TOKEN) {
      headers.set("Authorization", `Bearer ${context.env.GITHUB_TOKEN}`);
    }

    return fetch(new Request(request, { headers }));
  },
};

export function registerEgressHandlers(registry: EgressRegistry<GithubEnv>): void {
  registry.register(githubHandler);
}
