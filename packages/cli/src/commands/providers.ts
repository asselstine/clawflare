/**
 * Clawflare CLI - providers command
 * Manage AI model providers for your workspace
 */

import { input, select, confirm } from "@inquirer/prompts";
import { loadConfig } from "./login.js";
import { DEFAULT_SERVER } from "../constants.js";
import { AgentClient } from "../client.js";
import type { ModelConnection } from "@clawflare/types";

interface ProviderInfo {
  id: string;
  name: string;
  requiredSecrets: string[];
}

interface AddOptions {
  server?: string;
  token?: string;
}

interface RemoveOptions {
  server?: string;
  token?: string;
  name?: string;
}

interface ListOptions {
  server?: string;
  token?: string;
}

async function getClient(options: { server?: string; token?: string }): Promise<AgentClient> {
  const config = await loadConfig();

  const server = options.server || config.server || process.env.CLAWFLARE_URL || DEFAULT_SERVER;
  const token = options.token || config.token;

  if (!token) {
    console.error("Error: Not authenticated. Please run 'clawflare login' first.");
    process.exit(1);
  }

  return new AgentClient(server, token);
}

/**
 * Fetch supported providers from the server
 */
async function fetchProviders(client: AgentClient): Promise<ProviderInfo[]> {
  const response = await fetch(`${client.getUrl()}/v1/providers`, {
    headers: {
      Authorization: `Bearer ${client.getToken()}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch providers: ${response.statusText}`);
  }

  const data = (await response.json()) as { providers: ProviderInfo[] };
  return data.providers || [];
}

/**
 * Fetch existing model connections from the server
 */
async function fetchModelConnections(client: AgentClient): Promise<ModelConnection[]> {
  const { modelConnections } = await client.listModelConnections();
  return modelConnections;
}

/**
 * Add a new provider
 */
export async function providersAddCommand(options: AddOptions): Promise<void> {
  const client = await getClient(options);

  console.log("Fetching available providers...\n");

  let providers: ProviderInfo[];
  try {
    providers = await fetchProviders(client);
  } catch (error) {
    console.error(
      `Error: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exit(1);
  }

  if (providers.length === 0) {
    console.error("No providers available from server.");
    process.exit(1);
  }

  // Let user select a provider with autocomplete
  const providerChoices = providers.map((p) => ({
    name: p.id,
    value: p,
    description: p.requiredSecrets.length > 0
      ? `Requires: ${p.requiredSecrets.join(", ")}`
      : "No credentials required",
  }));

  const selectedProvider = await select({
    message: "Select a provider:",
    choices: providerChoices,
  });

  console.log(`\nConfiguring ${selectedProvider.id}...\n`);

  // Prompt for each required secret
  const secrets: Record<string, string> = {};
  for (const secretKey of selectedProvider.requiredSecrets) {
    const secretValue = await input({
      message: `${secretKey}:`,
      transformer: (input: string) => "*".repeat(input.length),
    });
    if (secretValue.trim()) {
      secrets[secretKey] = secretValue.trim();
    }
  }

  // Validate that all required secrets are provided
  const missingSecrets = selectedProvider.requiredSecrets.filter(
    (key) => !secrets[key]
  );
  if (missingSecrets.length > 0) {
    console.error(`\nError: Missing required secrets: ${missingSecrets.join(", ")}`);
    process.exit(1);
  }

  // Check if user wants to set as default
  const setAsDefault = await confirm({
    message: "Set as default model connection?",
    default: true,
  });

  console.log("\nCreating model connection...");

  try {
    // Get the default model for this provider from the server
    // We need to use the first available model or ask the user
    // For now, we'll need to get models from the server
    const modelName = await fetchDefaultModelForProvider(client, selectedProvider.id);

    const connection = await client.createModelConnection({
      provider: selectedProvider.id as
        | "amazon-bedrock"
        | "anthropic"
        | "openai"
        | "cloudflare-workers-ai",
      modelName,
      secrets,
      setAsDefault,
    });

    console.log(`\n✓ Model connection created successfully!`);
    console.log(`  ID: ${connection.id}`);
    console.log(`  Provider: ${connection.provider}`);
    console.log(`  Model: ${connection.modelName}`);
    if (setAsDefault) {
      console.log(`  Set as default: Yes`);
    }
  } catch (error) {
    console.error(
      `\n✗ Failed to create model connection: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    process.exit(1);
  }
}

/**
 * Fetch default model for a provider from pi-ai
 * Returns a reasonable default model for the provider
 */
async function fetchDefaultModelForProvider(
  _client: AgentClient,
  providerId: string
): Promise<string> {
  // Map of provider defaults based on pi-ai
  const defaults: Record<string, string> = {
    "amazon-bedrock": "minimax.minimax-m2.5",
    anthropic: "claude-3-opus-20240229",
    openai: "gpt-4",
    "cloudflare-workers-ai": "@cf/meta/llama-2-7b-chat-int8",
    deepseek: "deepseek-chat",
    "openai-codex": "codex-latest",
    xai: "grok-2",
    groq: "llama-3.3-70b-versatile",
    cerebras: "llama-3.3-70b",
    mistral: "mistral-large-latest",
    minimax: "minimax-m2.5",
    "minimax-cn": "minimax-m2.5",
    moonshotai: "moonshot-v1-128k",
    "moonshot-ai-cn": "moonshot-v1-128k",
    fireworks: "accounts/fireworks/models/llama-v3p1-70b-instruct",
    kimi: "kimi-k2",
    "kimi-coding": "kimi-k2-coding",
    google: "gemini-2.5-flash",
    "google-vertex": "gemini-2.5-flash",
    "azure-openai-responses": "gpt-4o",
  };

  return defaults[providerId] || "unknown";
}

/**
 * Remove a provider
 */
export async function providersRemoveCommand(options: RemoveOptions): Promise<void> {
  const client = await getClient(options);

  const connections = await fetchModelConnections(client);

  if (connections.length === 0) {
    console.log("No model connections to remove.");
    return;
  }

  let connectionId: string;

  if (options.name) {
    // Find by display name or id
    const match = connections.find(
      (c) => c.displayName === options.name || c.id === options.name
    );
    if (!match) {
      console.error(`Error: Model connection "${options.name}" not found.`);
      process.exit(1);
    }
    connectionId = match.id;
  } else {
    // Interactive selection
    const choices = connections.map((c) => ({
      name: c.displayName || `${c.provider} - ${c.modelName}`,
      value: c.id,
      description: `ID: ${c.id.slice(0, 8)}...`,
    }));

    connectionId = await select({
      message: "Select a model connection to remove:",
      choices,
    });
  }

  const confirmDelete = await confirm({
    message: "Are you sure you want to remove this model connection?",
    default: false,
  });

  if (!confirmDelete) {
    console.log("Cancelled.");
    return;
  }

  console.log("\nRemoving model connection...");

  try {
    await client.deleteModelConnection(connectionId);
    console.log("\n✓ Model connection removed successfully!");
  } catch (error) {
    console.error(
      `\n✗ Failed to remove model connection: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    process.exit(1);
  }
}

/**
 * List providers
 */
export async function providersListCommand(options: ListOptions): Promise<void> {
  const client = await getClient(options);

  try {
    const connections = await fetchModelConnections(client);

    if (connections.length === 0) {
      console.log("\nNo model connections configured.");
      console.log("Run 'clawflare providers add' to add a provider.\n");
      return;
    }

    console.log("\nConfigured model connections:\n");

    // Get default
    const { defaultModelConnectionId } = await client.listModelConnections();

    for (const conn of connections) {
      const isDefault = conn.id === defaultModelConnectionId;
      console.log(`  ${conn.displayName || `${conn.provider} - ${conn.modelName}`}`);
      console.log(`    ID: ${conn.id}`);
      console.log(`    Provider: ${conn.provider}`);
      console.log(`    Model: ${conn.modelName}`);
      console.log(`    Secrets: ${conn.configuredSecrets.join(", ") || "none"}`);
      if (isDefault) {
        console.log(`    [DEFAULT]`);
      }
      console.log();
    }
  } catch (error) {
    console.error(
      `Error: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exit(1);
  }
}
