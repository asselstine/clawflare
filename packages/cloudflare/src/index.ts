import {
  defineHttpEgressHandler,
  type HttpEgressHandlerContext,
  type EgressHandler,
} from "@clawflare/egress-core";

export const domains = ["api.cloudflare.com"];

export const metadata = {
  name: "cloudflare",
  description: "Cloudflare REST API access - automatically injects Authorization: Bearer token from CLOUDFLARE_API_TOKEN",
  domains,
} as const;

interface CloudflareEnv {
  CLOUDFLARE_API_TOKEN: string;
  MOCK_EGRESS?: string;
}

export const cloudflareHandler = defineHttpEgressHandler<CloudflareEnv>({
  name: metadata.name,
  description: metadata.description,
  domains,

  async decorateHeaders(headers: Headers, _request: Request, context: HttpEgressHandlerContext<CloudflareEnv>): Promise<void> {
    const token = context.env.CLOUDFLARE_API_TOKEN;
    if (token) {
      headers.set("Authorization", `Bearer ${token}`);
    }
  },
});

export function registerEgressHandlers(registry: { register: (handler: typeof cloudflareHandler) => void }): void {
  registry.register(cloudflareHandler);
}

/**
 * Cloudflare plugin for Clawflare.
 * Adds Cloudflare API egress handling with automatic authentication.
 */
export function cloudflare(): {
  name: string;
  registerEgress: () => EgressHandler;
} {
  return {
    name: "cloudflare",
    registerEgress: () => cloudflareHandler,
  };
}
