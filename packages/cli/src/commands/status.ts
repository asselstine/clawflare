/**
 * Clawflare CLI - status command
 * Show deployment status
 */

import * as fs from "fs/promises";
import * as path from "path";

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
  const state = await loadState(cwd);

  if (!state) {
    console.log("No deployment state found.");
    console.log("Run 'clawflare deploy' first.");
    return;
  }

  console.log("Clawflare Project Status\n");
  console.log(`Project: ${state.projectName || "unknown"}`);
  
  if (state.cloudflare) {
    console.log("\nCloudflare:");
    console.log(`  Account ID: ${state.cloudflare.accountId || "not set"}`);
    console.log(`  Worker: ${state.cloudflare.workerName || "not set"}`);
    console.log(`  Database: ${state.cloudflare.d1DatabaseName || "not set"}`);
    console.log(`  Database ID: ${state.cloudflare.d1DatabaseId || "not set"}`);
  }
  
  if (state.deployment) {
    console.log("\nDeployment:");
    console.log(`  URL: ${state.deployment.url || "not set"}`);
    if (state.deployment.lastDeployedAt) {
      const date = new Date(state.deployment.lastDeployedAt);
      console.log(`  Last deployed: ${date.toLocaleString()}`);
    }
  } else {
    console.log("\nNo active deployment. Run 'clawflare deploy' to deploy.");
  }
}
