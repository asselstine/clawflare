/**
 * Clawflare CLI - status command
 * Show deployment status
 */

import * as fs from "fs/promises";
import * as path from "path";
import { loadConfigFromCwd, ConfigValidationError } from "../lib/load-project-config.js";

interface StateFile {
  version: number;
  projectName?: string;
  cloudflare?: {
    accountId?: string;
    workerName?: string;
    d1DatabaseName?: string;
    d1DatabaseId?: string;
  };
  deployment?: {
    url?: string;
    lastDeployedAt?: string;
  };
}

async function loadState(projectDir: string): Promise<StateFile | null> {
  try {
    const statePath = path.join(projectDir, ".clawflare", "state.json");
    const content = await fs.readFile(statePath, "utf-8");
    return JSON.parse(content) as StateFile;
  } catch {
    return null;
  }
}

export async function statusCommand(): Promise<void> {
  const cwd = process.cwd();

  // Load real config
  let loadedConfig;
  try {
    loadedConfig = await loadConfigFromCwd();
  } catch (error) {
    if (error instanceof ConfigValidationError) {
      console.error(`Error: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }

  const config = loadedConfig.config;
  const state = await loadState(cwd);

  console.log("Clawflare Project Status\n");
  console.log(`Project: ${config.name}`);

  if (config.ai?.provider) {
    console.log(`AI Provider: ${config.ai.provider}`);
  }
  if (config.ai?.model) {
    console.log(`AI Model: ${config.ai.model}`);
  }

  if (state?.cloudflare) {
    console.log("\nCloudflare:");
    console.log(`  Account ID: ${state.cloudflare.accountId || "not set"}`);
    console.log(`  Worker: ${state.cloudflare.workerName || "not set"}`);
    console.log(`  Database: ${state.cloudflare.d1DatabaseName || "not set"}`);
    console.log(`  Database ID: ${state.cloudflare.d1DatabaseId || "not set"}`);
  }

  if (state?.deployment) {
    console.log("\nDeployment:");
    console.log(`  URL: ${state.deployment.url || "not set"}`);
    if (state.deployment.lastDeployedAt) {
      const date = new Date(state.deployment.lastDeployedAt);
      console.log(`  Last deployed: ${date.toLocaleString()}`);
    }
  } else {
    console.log("\nNo active deployment. Run 'clawflare deploy' to deploy.");
  }

  // Check for configured secrets
  if (config.secrets && config.secrets.length > 0) {
    console.log("\nConfigured Secrets:");
    for (const secret of config.secrets) {
      const marker = secret.required ? "*" : "";
      console.log(`  ${secret.name}${marker}: ${secret.description || ""}`);
    }
    if (config.secrets.some((s) => s.required)) {
      console.log("  (* = required)");
    }
  }
}
