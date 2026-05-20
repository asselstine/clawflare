import { hostnameMatchesDomain, type EgressContext, type EgressHandler, type EgressRegistry } from "@clawflare/egress-core";

interface CloudflareEnv {
  CLOUDFLARE_API_TOKEN: string;
  MOCK_AI?: string;
}

const domains = ["api.cloudflare.com"];

const cloudflareHandler: EgressHandler<CloudflareEnv> = {
  name: "cloudflare",
  description: "Cloudflare REST API access - automatically injects Authorization: Bearer token from CLOUDFLARE_API_TOKEN",
  domains,

  handles(request: Request): boolean {
    const hostname = new URL(request.url).hostname;
    return domains.some((domain) => hostnameMatchesDomain(hostname, domain));
  },

  async fetch(request: Request, context: EgressContext<CloudflareEnv>): Promise<Response> {
    if (context.env.MOCK_AI === "true") {
      return Response.json({ ok: true, handler: "cloudflare", url: request.url });
    }

    const headers = new Headers(request.headers);
    headers.set("Authorization", `Bearer ${context.env.CLOUDFLARE_API_TOKEN}`);

    return fetch(new Request(request, { headers }));
  },
};

export function registerEgressHandlers(registry: EgressRegistry<CloudflareEnv>): void {
  registry.register(cloudflareHandler);
}
