import { metadata as cloudflareMetadata } from "@clawflare/cloudflare";
import { metadata as githubMetadata } from "@clawflare/github";

export interface EgressHandlerDefinition {
  egressHandlerId: string;
  name: string;
  description: string;
  domains: string[];
  requiredSecrets: string[];
  optionalSecrets: string[];
  configSchema?: Record<string, unknown>;
}

const EGRESS_HANDLER_DEFINITIONS: EgressHandlerDefinition[] = [
  {
    egressHandlerId: githubMetadata.name,
    name: "GitHub",
    description: githubMetadata.description,
    domains: [...githubMetadata.domains],
    requiredSecrets: [],
    optionalSecrets: ["GITHUB_TOKEN"],
    configSchema: {
      type: "object",
      properties: {
        GITHUB_USERNAME: {
          type: "string",
          description: "GitHub username used with GITHUB_TOKEN for native Git smart-HTTP Basic authentication.",
        },
        GITHUB_SMART_HTTP_EGRESS: {
          type: "string",
          enum: ["enabled", "disabled"],
          description: "Set to disabled to block native Git smart-HTTP pass-through.",
        },
      },
    },
  },
  {
    egressHandlerId: cloudflareMetadata.name,
    name: "Cloudflare",
    description: cloudflareMetadata.description,
    domains: [...cloudflareMetadata.domains],
    requiredSecrets: ["CLOUDFLARE_API_TOKEN"],
    optionalSecrets: [],
  },
];

export function listEgressHandlerDefinitions(): EgressHandlerDefinition[] {
  return EGRESS_HANDLER_DEFINITIONS.map((definition) => ({
    ...definition,
    domains: [...definition.domains],
    requiredSecrets: [...definition.requiredSecrets],
    optionalSecrets: [...definition.optionalSecrets],
    configSchema: definition.configSchema ? { ...definition.configSchema } : undefined,
  }));
}

export function getEgressHandlerDefinition(egressHandlerId: string): EgressHandlerDefinition | null {
  return listEgressHandlerDefinitions().find((definition) => definition.egressHandlerId === egressHandlerId) ?? null;
}

export function requiredSecretsForEgressHandler(egressHandlerId: string): string[] {
  return getEgressHandlerDefinition(egressHandlerId)?.requiredSecrets ?? [];
}

export function optionalSecretsForEgressHandler(egressHandlerId: string): string[] {
  return getEgressHandlerDefinition(egressHandlerId)?.optionalSecrets ?? [];
}

export function isEgressHandlerSupported(egressHandlerId: string): boolean {
  return Boolean(getEgressHandlerDefinition(egressHandlerId));
}
