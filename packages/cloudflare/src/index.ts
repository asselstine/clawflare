import { defineHttpEgressHandler, type HttpEgressHandlerContext } from "@clawflare/egress-core";

export const domains = ["api.cloudflare.com"];

export const metadata = {
  name: "cloudflare",
  description: "Cloudflare REST API access - automatically injects Authorization: Bearer token from CLOUDFLARE_API_TOKEN",
  domains,
} as const;

interface CloudflareEnv {
  CLOUDFLARE_API_TOKEN: string;
  MOCK_AI?: string;
}

export const cloudflareHandler = defineHttpEgressHandler<CloudflareEnv>({
  name: metadata.name,
  description: metadata.description,
  domains,

  async decorateHeaders(headers, _request: Request, context: HttpEgressHandlerContext<CloudflareEnv>): Promise<void> {
    headers.set("Authorization", `Bearer ${context.env.CLOUDFLARE_API_TOKEN}`);
  },
});

export function registerEgressHandlers(registry: { register: (handler: typeof cloudflareHandler) => void }): void {
  registry.register(cloudflareHandler);
}
