import {
  defineHttpEgressHandler,
  type EgressHandler,
  type HttpEgressHandlerContext,
} from "@clawflare/egress-core";

export const domains = ["api.netlify.com"];

export const metadata = {
  name: "netlify",
  description:
    "Netlify REST API access for api.netlify.com. Send the Netlify API request without an Authorization header; Clawflare automatically adds Authorization: Bearer <NETLIFY_AUTH_TOKEN> and the required User-Agent header.",
  domains,
} as const;

interface NetlifyEnv {
  NETLIFY_AUTH_TOKEN: string;
  MOCK_EGRESS?: string;
}

export function decorateNetlifyHeaders(
  headers: Headers,
  _request: Request,
  context: HttpEgressHandlerContext<NetlifyEnv>
): void {
  headers.set("User-Agent", headers.get("User-Agent") || "Clawflare-Agent");

  const token = context.env.NETLIFY_AUTH_TOKEN;
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }
}

export const netlifyHandler = defineHttpEgressHandler<NetlifyEnv>({
  name: metadata.name,
  description: metadata.description,
  domains,

  decorateHeaders: decorateNetlifyHeaders,
});

export function registerEgressHandlers(registry: { register: (handler: typeof netlifyHandler) => void }): void {
  registry.register(netlifyHandler);
}

/**
 * Netlify plugin for Clawflare.
 * Adds Netlify API egress handling with automatic authentication.
 */
export function netlify(): {
  name: string;
  registerEgress: () => EgressHandler;
} {
  return {
    name: "netlify",
    registerEgress: () => netlifyHandler,
  };
}
