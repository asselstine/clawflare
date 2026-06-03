import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { Static, TSchema } from "@earendil-works/pi-ai";
import { EgressHandlerRepository, StoredCodeRepository, type EgressHandlerMetadata } from "../../../data/index.js";
import { getEgressHandlerDefinition } from "../../egress-handlers/egress-handlers.catalog.js";
import {
  requireBuiltinToolContext,
  type RuntimeTool,
  type ToolModule,
  type ToolRuntimeContext,
} from "../types.js";

interface SearchParams {
  collection?: "stored_code" | "egress_handlers" | "all";
  query?: string;
  limit?: number;
}

export const searchTool: RuntimeTool = {
  ref: "search.search",
  groupId: "search",
  name: "search",
  description:
    "Search stored code and egress handlers. Use this to find reusable code or discover whether configured egress handlers provide authenticated outbound HTTP access for external services, accounts, resources, profiles, or APIs before claiming access is unavailable.",
  label: "Search",
  parameters: Type.Object({
    collection: Type.Optional(
      Type.Union(
        [
          Type.Literal("stored_code", { description: "Search stored code only" }),
          Type.Literal("egress_handlers", { description: "Search egress handlers only" }),
          Type.Literal("all", { description: "Search both collections" }),
        ],
        { description: "Collection to search" }
      )
    ),
    query: Type.Optional(Type.String({ description: "Search query string. Supports * as wildcard (e.g., *github.com). Use * alone to list all." })),
    limit: Type.Optional(Type.Number({ description: "Maximum results to return (max 20)" })),
  }) as TSchema,
  execute: async (
    context: ToolRuntimeContext,
    _toolCallId: string,
    params: Static<TSchema>,
    _signal?: AbortSignal
  ): Promise<AgentToolResult<unknown>> => {
    const runtime = requireBuiltinToolContext(context);
    const p = params as SearchParams;

    const collection = p.collection || "all";
    const limit = Math.min(p.limit || 20, 20);

    const storedCode = new StoredCodeRepository(runtime.env.DB);
    const egressHandlers = new EgressHandlerRepository(runtime.env.DB);

    let results: { storedCode: import("../../../data/index.js").StoredCodeEntry[]; egressHandlers: import("../../../data/index.js").EgressHandlerMetadata[] };

    if (collection === "stored_code") {
      results = {
        storedCode: await storedCode.search(runtime.workspaceId, p.query ?? "*", limit),
        egressHandlers: [],
      };
    } else if (collection === "egress_handlers") {
      results = {
        storedCode: [],
        egressHandlers: await egressHandlers.search(runtime.workspaceId, p.query ?? "*", limit),
      };
    } else {
      const [storedCodeResults, egressHandlerResults] = await Promise.all([
        storedCode.search(runtime.workspaceId, p.query ?? "*", limit),
        egressHandlers.search(runtime.workspaceId, p.query ?? "*", limit),
      ]);
      results = {
        storedCode: storedCodeResults,
        egressHandlers: egressHandlerResults,
      };
    }

    const lines: string[] = [];

    if (collection === "stored_code" || collection === "all") {
      lines.push(`Stored Code (${results.storedCode.length}):`);
      for (const code of results.storedCode) {
        lines.push(`  - ${code.name}: ${code.description || "(no description)"}`);
        lines.push(`    updated: ${new Date(code.updatedAt).toISOString()}`);
      }
      if (results.storedCode.length === 0) {
        lines.push("  (none found)");
      }
    }

    if (collection === "egress_handlers" || collection === "all") {
      lines.push(`Egress Handlers (${results.egressHandlers.length}):`);
      for (const handler of results.egressHandlers) {
        const definition = getEgressHandlerDefinition(handler.egressHandlerId);
        const configuredSecrets = Object.keys(handler.secretRefs);
        const configKeys = configuredConfigKeys(handler);

        const description = definition?.description ?? handler.description;
        lines.push(`  - ${handler.name} (${handler.egressHandlerId}): ${description || "(no description)"}`);
        lines.push(`    enabled: ${handler.enabled}`);
        lines.push(`    domains: ${handler.domains.join(", ")}`);
        lines.push(`    configured secrets: ${configuredSecrets.join(", ") || "none"}`);
        if (definition) {
          lines.push(`    required secrets: ${definition.requiredSecrets.join(", ") || "none"}`);
          lines.push(`    optional secrets: ${definition.optionalSecrets.join(", ") || "none"}`);
        }
        lines.push(`    configured config keys: ${configKeys.join(", ") || "none"}`);
      }
      if (results.egressHandlers.length === 0) {
        lines.push("  (none found)");
      }
    }

    const publicStoredCode = results.storedCode.map(({ code: _code, ...entry }) => entry);

    return {
      content: [{ type: "text", text: lines.join("\n") }],
      details: {
        storedCode: publicStoredCode,
        egressHandlers: results.egressHandlers,
        workspaceId: runtime.workspaceId,
      },
    };
  },
};

function objectKeys(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }
  return Object.keys(value);
}

function configuredConfigKeys(handler: EgressHandlerMetadata): string[] {
  const keys = objectKeys(handler.config);
  const definition = getEgressHandlerDefinition(handler.egressHandlerId);
  if (!definition?.configSchema) {
    return keys;
  }

  const properties = definition.configSchema.properties;
  const allowed = properties && typeof properties === "object" && !Array.isArray(properties)
    ? new Set(Object.keys(properties))
    : undefined;
  return allowed ? keys.filter((key) => allowed.has(key)) : keys;
}

export const searchToolModule: ToolModule = {
  id: "search",
  label: "Search",
  tools: [searchTool],
};
