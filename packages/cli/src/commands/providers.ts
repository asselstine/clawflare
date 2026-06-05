/**
 * Clawflare CLI - providers command
 * Manage AI model providers for your workspace
 */

import { password, select, confirm } from "@inquirer/prompts";
import { loadConfig } from "./login.js";
import { DEFAULT_SERVER } from "../constants.js";
import { AgentClient } from "../client.js";
import type { Model, ProviderInfo, ProviderModelInfo } from "@clawflare/types";

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
  available?: boolean;
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
  return client.listProviders();
}

/**
 * Fetch supported models for a provider from the server
 */
async function fetchProviderModels(
  client: AgentClient,
  providerId: string
): Promise<ProviderModelInfo[]> {
  return client.listProviderModels(providerId);
}

/**
 * Fetch existing models from the server
 */
async function fetchModels(client: AgentClient): Promise<Model[]> {
  const { models } = await client.listModels();
  return models;
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
      : p.optionalSecrets.length > 0
        ? `Optional: ${p.optionalSecrets.join(", ")}`
        : "No credentials required",
  }));

  const selectedProvider = await select({
    message: "Select a provider:",
    choices: providerChoices,
  });

  console.log(`\nConfiguring ${selectedProvider.id}...\n`);

  const models = await fetchProviderModels(client, selectedProvider.id);
  if (models.length === 0) {
    console.error(`No models available for provider "${selectedProvider.id}".`);
    process.exit(1);
  }

  const selectedModel = await select({
    message: "Select a model:",
    pageSize: 20,
    choices: models.map((model) => ({
      name: `${model.name} (${model.id})`,
      value: model,
      description: [
        model.api,
        model.contextWindow ? `${model.contextWindow.toLocaleString()} ctx` : undefined,
        model.maxTokens ? `${model.maxTokens.toLocaleString()} max` : undefined,
        model.reasoning ? "reasoning" : undefined,
      ].filter(Boolean).join(" • "),
    })),
  });

  // Prompt for each required secret
  const secrets: Record<string, string> = {};
  for (const secretKey of selectedProvider.requiredSecrets) {
    const secretValue = await password({
      message: `${secretKey} (required):`,
      mask: true,
    });
    if (secretValue.trim()) {
      secrets[secretKey] = secretValue.trim();
    }
  }

  // Prompt for optional secrets
  for (const secretKey of selectedProvider.optionalSecrets) {
    const secretValue = await password({
      message: `${secretKey} (optional):`,
      mask: true,
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
    message: "Set as default model?",
    default: true,
  });

  console.log("\nCreating model...");

  try {
    const model = await client.createModel({
      provider: selectedProvider.id,
      modelName: selectedModel.id,
      secrets,
      setAsDefault,
    });

    console.log(`\n✓ Model created successfully!`);
    console.log(`  ID: ${model.id}`);
    console.log(`  Provider: ${model.provider}`);
    console.log(`  Model: ${model.modelName}`);
    if (setAsDefault) {
      console.log(`  Set as default: Yes`);
    }
  } catch (error) {
    console.error(
      `\n✗ Failed to create model: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    process.exit(1);
  }
}

/**
 * Remove a provider
 */
export async function providersRemoveCommand(options: RemoveOptions): Promise<void> {
  const client = await getClient(options);

  const models = await fetchModels(client);

  if (models.length === 0) {
    console.log("No models to remove.");
    return;
  }

  let modelId: string;

  if (options.name) {
    // Find by display name or id
    const match = models.find(
      (c) => c.displayName === options.name || c.id === options.name
    );
    if (!match) {
      console.error(`Error: Model "${options.name}" not found.`);
      process.exit(1);
    }
    modelId = match.id;
  } else {
    // Interactive selection
    const choices = models.map((c) => ({
      name: c.displayName || `${c.provider} - ${c.modelName}`,
      value: c.id,
      description: `ID: ${c.id.slice(0, 8)}...`,
    }));

    modelId = await select({
      message: "Select a model to remove:",
      choices,
    });
  }

  const confirmDelete = await confirm({
    message: "Are you sure you want to remove this model?",
    default: false,
  });

  if (!confirmDelete) {
    console.log("Cancelled.");
    return;
  }

  console.log("\nRemoving model...");

  try {
    await client.deleteModel(modelId);
    console.log("\n✓ Model removed successfully!");
  } catch (error) {
    console.error(
      `\n✗ Failed to remove model: ${
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

  if (!options.available) {
    await modelsListCommand(options);
    return;
  }

  try {
    const providers = await fetchProviders(client);

    if (providers.length === 0) {
      console.log("\nNo providers available from server.\n");
      return;
    }

    console.log("\nAvailable providers:\n");

    for (const provider of providers) {
      console.log(`  ${provider.name || provider.id}`);
      console.log(`    ID: ${provider.id}`);
      console.log(`    Required secrets: ${provider.requiredSecrets.join(", ") || "none"}`);
      console.log(`    Optional secrets: ${provider.optionalSecrets.join(", ") || "none"}`);
      console.log();
    }
  } catch (error) {
    console.error(
      `Error: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exit(1);
  }
}

/**
 * List configured models
 */
export async function modelsListCommand(options: ListOptions): Promise<void> {
  const client = await getClient(options);

  try {
    const connections = await fetchModels(client);

    if (connections.length === 0) {
      console.log("\nNo models configured.");
      console.log("Run 'clawflare providers add' to add a provider and model.\n");
      return;
    }

    console.log("\nConfigured models:\n");

    // Get default
    const { defaultModelId } = await client.listModels();

    for (const conn of connections) {
      const isDefault = conn.id === defaultModelId;
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
