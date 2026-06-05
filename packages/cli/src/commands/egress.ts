/**
 * Clawflare CLI - egress command
 * Manage workspace egress handlers.
 */

import { confirm, input, password, select } from "@inquirer/prompts";
import { loadConfig } from "./login.js";
import { DEFAULT_SERVER } from "../constants.js";
import { AgentClient } from "../client.js";
import type { EgressHandlerInfo } from "@clawflare/types";

interface BaseOptions {
  server?: string;
  token?: string;
}

interface ListOptions extends BaseOptions {
  available?: boolean;
}

interface ToggleOptions extends BaseOptions {
  egressHandlerId?: string;
}

interface AddOptions extends BaseOptions {
  egressHandlerId?: string;
}

async function getClient(options: BaseOptions): Promise<AgentClient> {
  const config = await loadConfig();

  const server = options.server || config.server || process.env.CLAWFLARE_URL || DEFAULT_SERVER;
  const token = options.token || config.token;

  if (!token) {
    console.error("Error: Not authenticated. Please run 'clawflare login' first.");
    process.exit(1);
  }

  return new AgentClient(server, token);
}

function formatSecretSummary(handler: EgressHandlerInfo): string {
  const required = handler.requiredSecrets.length
    ? `required: ${handler.requiredSecrets.join(", ")}`
    : "required: none";
  const optional = handler.optionalSecrets.length
    ? `optional: ${handler.optionalSecrets.join(", ")}`
    : "optional: none";
  return `${required}; ${optional}`;
}

async function promptForConfig(handler: EgressHandlerInfo): Promise<Record<string, unknown>> {
  const config: Record<string, unknown> = {};
  const properties = handler.configSchema?.properties;
  if (!properties || typeof properties !== "object") {
    return config;
  }

  for (const [key, schema] of Object.entries(properties as Record<string, Record<string, unknown>>)) {
    const choices = Array.isArray(schema.enum)
      ? schema.enum.filter((value): value is string => typeof value === "string")
      : [];

    if (choices.length > 0) {
      const value = await select({
        message: `${key}:`,
        choices: choices.map((choice) => ({ name: choice, value: choice })),
      });
      config[key] = value;
    } else {
      const value = await input({
        message: `${key} (optional):`,
      });
      if (value.trim()) {
        config[key] = value.trim();
      }
    }
  }

  return config;
}

function findAvailableHandler(
  handlers: EgressHandlerInfo[],
  egressHandlerId?: string
): EgressHandlerInfo | undefined {
  if (!egressHandlerId) return undefined;
  return handlers.find((handler) => handler.egressHandlerId === egressHandlerId);
}

export async function egressAddCommand(options: AddOptions): Promise<void> {
  const client = await getClient(options);

  console.log("Fetching available egress handlers...\n");
  const handlers = await client.listAvailableEgressHandlers();
  if (handlers.length === 0) {
    console.log("No egress handlers are available.");
    return;
  }

  const selected = options.egressHandlerId
    ? findAvailableHandler(handlers, options.egressHandlerId)
    : await select({
        message: "Select an egress handler:",
        choices: handlers.map((handler) => ({
          name: handler.name,
          value: handler,
          description: `${handler.domains.join(", ")} • ${formatSecretSummary(handler)}`,
        })),
      });

  if (!selected) {
    console.error(`Error: Unknown egress handler "${options.egressHandlerId}".`);
    console.error(`Available handlers: ${handlers.map((handler) => handler.egressHandlerId).join(", ")}`);
    process.exit(1);
  }

  console.log(`\nConfiguring ${selected.name}...\n`);

  const secrets: Record<string, string> = {};
  for (const secretKey of selected.requiredSecrets) {
    const secretValue = await password({
      message: `${secretKey} (required):`,
      mask: true,
    });
    if (secretValue.trim()) {
      secrets[secretKey] = secretValue.trim();
    }
  }

  for (const secretKey of selected.optionalSecrets) {
    const secretValue = await password({
      message: `${secretKey} (optional):`,
      mask: true,
    });
    if (secretValue.trim()) {
      secrets[secretKey] = secretValue.trim();
    }
  }

  const missingSecrets = selected.requiredSecrets.filter((key) => !secrets[key]);
  if (missingSecrets.length > 0) {
    console.error(`\nError: Missing required secrets: ${missingSecrets.join(", ")}`);
    process.exit(1);
  }

  const config = await promptForConfig(selected);
  const enabled = await confirm({
    message: "Enable this egress handler now?",
    default: true,
  });

  const handler = await client.configureEgressHandler({
    egressHandlerId: selected.egressHandlerId,
    secrets,
    config,
    enabled,
  });

  console.log("\n✓ Egress handler configured successfully!");
  console.log(`  Name: ${handler.name}`);
  console.log(`  ID: ${handler.egressHandlerId}`);
  console.log(`  Domains: ${handler.domains.join(", ")}`);
  console.log(`  Secrets: ${handler.configuredSecrets.join(", ") || "none"}`);
  console.log(`  Enabled: ${handler.enabled ? "yes" : "no"}`);
}

export async function egressListCommand(options: ListOptions): Promise<void> {
  const client = await getClient(options);
  const handlers = options.available
    ? await client.listAvailableEgressHandlers()
    : (await client.listEgressHandlers({ enabledOnly: false })).filter(
        (handler) => handler.updatedAt > 0
      );

  if (handlers.length === 0) {
    console.log(
      options.available
        ? "\nNo egress handlers available.\n"
        : "\nNone are installed. To list handlers you can install using `egress list --available`\n"
    );
    return;
  }

  console.log(options.available ? "\nAvailable egress handlers:\n" : "\nSet up egress handlers:\n");
  for (const handler of handlers) {
    console.log(`  ${handler.name}`);
    console.log(`    ID: ${handler.egressHandlerId}`);
    console.log(`    Domains: ${handler.domains.join(", ")}`);
    console.log(`    Secrets: ${handler.configuredSecrets.join(", ") || formatSecretSummary(handler)}`);
    console.log(`    Enabled: ${handler.enabled ? "yes" : "no"}`);
    console.log();
  }
}

async function selectConfiguredHandler(client: AgentClient, egressHandlerId?: string): Promise<string> {
  if (egressHandlerId) return egressHandlerId;

  const handlers = (await client.listEgressHandlers({ enabledOnly: false })).filter(
    (handler) => handler.updatedAt > 0
  );
  if (handlers.length === 0) {
    console.error("No egress handlers configured.");
    process.exit(1);
  }

  return select({
    message: "Select an egress handler:",
    choices: handlers.map((handler) => ({
      name: handler.name,
      value: handler.egressHandlerId,
      description: handler.enabled ? "enabled" : "disabled",
    })),
  });
}

export async function egressEnableCommand(options: ToggleOptions): Promise<void> {
  const client = await getClient(options);
  const egressHandlerId = await selectConfiguredHandler(client, options.egressHandlerId);
  const handler = await client.updateEgressHandler(egressHandlerId, { enabled: true });
  console.log(`Enabled egress handler "${handler.name}".`);
}

export async function egressDisableCommand(options: ToggleOptions): Promise<void> {
  const client = await getClient(options);
  const egressHandlerId = await selectConfiguredHandler(client, options.egressHandlerId);
  const handler = await client.updateEgressHandler(egressHandlerId, { enabled: false });
  console.log(`Disabled egress handler "${handler.name}".`);
}

export async function egressRemoveCommand(options: ToggleOptions): Promise<void> {
  const client = await getClient(options);
  const egressHandlerId = await selectConfiguredHandler(client, options.egressHandlerId);
  const confirmed = await confirm({
    message: `Delete egress handler "${egressHandlerId}" and its stored secrets?`,
    default: false,
  });

  if (!confirmed) {
    console.log("Delete cancelled.");
    return;
  }

  await client.deleteEgressHandler(egressHandlerId);
  console.log(`Deleted egress handler "${egressHandlerId}".`);
}
