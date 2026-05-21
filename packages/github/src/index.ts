import { defineHttpEgressHandler, type HttpEgressHandlerContext } from "@clawflare/egress-core";

export const domains = ["api.github.com", "github.com", "raw.githubusercontent.com", "codeload.github.com"];

export const metadata = {
  name: "github",
  description:
    "GitHub API and content access - automatically injects Authorization: Bearer token and API version headers when GITHUB_TOKEN is configured for API requests",
  domains,
} as const;

interface GithubEnv {
  GITHUB_TOKEN?: string;
  GITHUB_SMART_HTTP_EGRESS?: string;
  MOCK_AI?: string;
}

export type GithubTrafficKind =
  | "api"
  | "raw"
  | "archive"
  | "git-smart-http"
  | "web"
  | "unknown";

export function classifyGithubRequest(request: Request): GithubTrafficKind {
  const url = new URL(request.url);
  const host = url.hostname.toLowerCase();
  const path = url.pathname;

  if (host === "api.github.com") return "api";
  if (host === "raw.githubusercontent.com") return "raw";
  if (host === "codeload.github.com") return "archive";

  if (host === "github.com") {
    if (
      path.includes(".git/") ||
      path.endsWith(".git") ||
      path.endsWith("/info/refs") ||
      path.endsWith("/git-upload-pack") ||
      path.endsWith("/git-receive-pack")
    ) {
      return "git-smart-http";
    }
    return "web";
  }

  return "unknown";
}

export function decorateGithubHeaders(
  headers: Headers,
  request: Request,
  context: HttpEgressHandlerContext<GithubEnv>
): void {
  const kind = classifyGithubRequest(request);

  if (kind !== "api") {
    return;
  }

  headers.set("Accept", headers.get("Accept") || "application/vnd.github+json");
  headers.set("X-GitHub-Api-Version", headers.get("X-GitHub-Api-Version") || "2022-11-28");

  if (context.env.GITHUB_TOKEN) {
    headers.set("Authorization", `Bearer ${context.env.GITHUB_TOKEN}`);
  }
}

function withDiagnosticHeaders(response: Response, kind: GithubTrafficKind): Response {
  const headers = new Headers(response.headers);
  headers.set("X-Clawflare-Egress-Handler", metadata.name);
  headers.set("X-Clawflare-Egress-Kind", kind);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

const baseGithubHandler = defineHttpEgressHandler<GithubEnv>({
  name: metadata.name,
  description: metadata.description,
  domains,

  decorateHeaders: decorateGithubHeaders,
});

export const githubHandler = {
  ...baseGithubHandler,

  async fetch(request: Request, context: HttpEgressHandlerContext<GithubEnv>): Promise<Response> {
    if (context.env.MOCK_AI === "true") {
      return Response.json({ ok: true, handler: metadata.name, url: request.url });
    }

    const kind = classifyGithubRequest(request);

    if (kind === "git-smart-http" && context.env.GITHUB_SMART_HTTP_EGRESS === "disabled") {
      return new Response(
        "Native Git smart-HTTP is disabled for this egress handler. " +
          "Use the GitHub archive clone path or enable Git smart-HTTP egress.",
        {
          status: 501,
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "X-Clawflare-Egress-Handler": metadata.name,
            "X-Clawflare-Egress-Kind": kind,
          },
        }
      );
    }

    const headers = new Headers(request.headers);

    if (kind === "git-smart-http") {
      headers.delete("X-GitHub-Api-Version");
      if (context.env.GITHUB_TOKEN && !headers.has("Authorization")) {
        headers.set("Authorization", `Bearer ${context.env.GITHUB_TOKEN}`);
      }
    } else {
      decorateGithubHeaders(headers, request, context);
    }

    const response = await fetch(new Request(request, { headers }));
    return withDiagnosticHeaders(response, kind);
  },
};

export function registerEgressHandlers(registry: { register: (handler: typeof githubHandler) => void }): void {
  registry.register(githubHandler);
}
