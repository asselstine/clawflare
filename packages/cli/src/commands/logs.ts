/**
 * Clawflare CLI - logs command
 * Stream logs from the deployed Worker
 */

import { execSync, spawn } from "child_process";
import * as fs from "fs/promises";
import * as path from "path";

interface LogsOptions {
  env?: string;
  follow?: boolean;
  local?: boolean;
  format?: "json" | "pretty";
  limit?: number;
  since?: string;
}

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

export async function logsCommand(options: LogsOptions): Promise<void> {
  const cwd = process.cwd();
  const state = await loadState(cwd);
  
  // Check for project structure
  try {
    await fs.access(path.join(cwd, "package.json"));
  } catch {
    console.error("Error: No Clawflare project found in current directory");
    console.error("Run 'clawflare init <name>' to create a new project");
    process.exit(1);
  }

  // Determine the wrangler config path
  const wranglerPath = path.join(cwd, ".clawflare", "wrangler.jsonc");
  
  try {
    await fs.access(wranglerPath);
  } catch {
    console.error("Error: No Wrangler configuration found");
    console.error("Run 'clawflare config generate' or 'clawflare deploy' first");
    process.exit(1);
  }

  // Build wrangler tail arguments
  const args = ["tail", "--config", wranglerPath];
  
  if (options.local || options.env === "local") {
    // For local dev, we just tell them to use dev mode
    console.log("For local development logs, use:");
    console.log("  clawflare dev");
    console.log("The dev command shows logs inline.");
    return;
  }

  // Add format option
  if (options.format === "json") {
    args.push("--format", "json");
  }

  // Add limit option
  if (options.limit && options.limit > 0) {
    args.push("--limit", options.limit.toString());
  }

  // Add since option
  if (options.since) {
    args.push("--since", options.since);
  }

  const workerName = state?.cloudflare?.workerName || "clawflare-worker";
  
  console.log(`Streaming logs for ${workerName}...`);
  console.log("Press Ctrl+C to stop\n");

  // Spawn wrangler tail
  const child = spawn("wrangler", args, {
    stdio: "inherit",
    shell: true,
  });

  // Handle exit
  child.on("exit", (code) => {
    process.exit(code || 0);
  });

  // Handle signals
  process.on("SIGINT", () => {
    child.kill("SIGINT");
  });
  process.on("SIGTERM", () => {
    child.kill("SIGTERM");
  });
}
