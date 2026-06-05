import {
  defineHttpEgressHandler,
  type HttpEgressHandlerContext,
  type EgressHandler,
} from "@clawflare/egress-core";

export const domains = ["api.github.com", "github.com", "raw.githubusercontent.com", "codeload.github.com"];

export const metadata = {
  name: "github",
  description:
    "GitHub API, content, archive, web, and native Git smart-HTTP egress. Injects REST API Bearer auth and, when GITHUB_USERNAME plus GITHUB_TOKEN are configured, Basic auth for HTTPS git clone, fetch, and push.",
  domains,
} as const;

interface GithubEnv {
  GITHUB_TOKEN?: string;
  GITHUB_USERNAME?: string;
  GITHUB_SMART_HTTP_EGRESS?: string;
  MOCK_EGRESS?: string;
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
    if (/^\/[^/]+\/[^/]+\/archive\/refs\//.test(path)) {
      return "archive";
    }

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
  const handlerEnv = context.env;

  if (kind === "api") {
    headers.set("User-Agent", headers.get("User-Agent") || "Clawflare-Agent");
    headers.set("Accept", headers.get("Accept") || "application/vnd.github+json");
    headers.set("X-GitHub-Api-Version", headers.get("X-GitHub-Api-Version") || "2022-11-28");

    if (handlerEnv.GITHUB_TOKEN) {
      headers.set("Authorization", `Bearer ${handlerEnv.GITHUB_TOKEN}`);
    }
  }

  if (kind === "raw" || kind === "archive" || kind === "web") {
    headers.set("User-Agent", headers.get("User-Agent") || "Clawflare-Agent");
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

function createOutboundRequest(request: Request, headers: Headers): Request {
  return new Request(request.url, {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
    redirect: request.redirect,
  });
}

function createGithubSmartHttpAuthorization(username: string, token: string): string {
  return `Basic ${btoa(`${username}:${token}`)}`;
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
    const kind = classifyGithubRequest(request);
    const handlerEnv = context.env;

    context.logger.info("GitHub egress request", {
      handler: metadata.name,
      kind,
      requestId: context.requestId,
      url: request.url,
    });

    if (handlerEnv.MOCK_EGRESS === "true" && kind !== "git-smart-http") {
      return Response.json({ ok: true, handler: metadata.name, url: request.url });
    }

    if (kind === "git-smart-http" && handlerEnv.GITHUB_SMART_HTTP_EGRESS === "disabled") {
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
      headers.delete("Origin");
      headers.delete("Referer");
      headers.delete("Sec-Fetch-Dest");
      headers.delete("Sec-Fetch-Mode");
      headers.delete("Sec-Fetch-Site");
      headers.delete("Sec-Fetch-User");
      headers.delete("Authorization");
      if (handlerEnv.GITHUB_USERNAME && handlerEnv.GITHUB_TOKEN) {
        headers.set(
          "Authorization",
          createGithubSmartHttpAuthorization(handlerEnv.GITHUB_USERNAME, handlerEnv.GITHUB_TOKEN)
        );
        const url = new URL(request.url);
        context.logger.info("Injected Git smart-HTTP Basic auth", {
          handler: metadata.name,
          path: url.pathname,
          requestId: context.requestId,
        });
      } else {
        const url = new URL(request.url);
        context.logger.warn("Skipping Git smart-HTTP Basic auth injection", {
          handler: metadata.name,
          hasGithubUsername: Boolean(handlerEnv.GITHUB_USERNAME),
          hasGithubToken: Boolean(handlerEnv.GITHUB_TOKEN),
          path: url.pathname,
          requestId: context.requestId,
        });
      }
    } else {
      decorateGithubHeaders(headers, request, context);
    }

    const response = await fetch(createOutboundRequest(request, headers));
    return withDiagnosticHeaders(response, kind);
  },
};

export function registerEgressHandlers(registry: { register: (handler: typeof githubHandler) => void }): void {
  registry.register(githubHandler);
}

/**
 * GitHub plugin for Clawflare.
 * Adds GitHub API egress handling with automatic authentication.
 */
export function github(): {
  name: string;
  registerEgress: () => EgressHandler;
} {
  return {
    name: "github",
    registerEgress: () => githubHandler,
  };
}
