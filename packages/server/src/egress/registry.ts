import { EgressRegistry } from "@clawflare/egress-core";
import { registerEgressHandlers as registerGithub } from "@clawflare/github";
import { registerEgressHandlers as registerCloudflare } from "@clawflare/cloudflare";
import { registerEgressHandlers as registerNetlify } from "@clawflare/netlify";
import type { Env } from "../internal-types/index.js";

export function createEgressRegistry<TEnv = Env>(): EgressRegistry<TEnv> {
  const registry = new EgressRegistry<TEnv>();
  registerGithub(registry as EgressRegistry<unknown>);
  registerCloudflare(registry as EgressRegistry<unknown>);
  registerNetlify(registry as EgressRegistry<unknown>);
  return registry;
}
