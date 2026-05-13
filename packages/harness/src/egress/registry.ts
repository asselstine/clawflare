import { EgressRegistry } from "@clawflare/egress-core";
import { registerEgressHandlers as registerGithub } from "@clawflare/github";
import { registerEgressHandlers as registerCloudflare } from "@clawflare/cloudflare";
import type { Env } from "../types";

export function createEgressRegistry(): EgressRegistry<Env> {
  const registry = new EgressRegistry<Env>();
  registerGithub(registry as never);
  registerCloudflare(registry as never);
  return registry;
}
