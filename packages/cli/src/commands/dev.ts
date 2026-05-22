/**
 * Clawflare CLI - dev command
 * Start local development server
 */

import { execSync, spawn } from "child_process";
import * as fs from "fs/promises";
import * as path from "path";
import { generateWranglerConfig } from "./config.js";
import {
  loadConfigFromCwd,
  getWorkerName,
  getWorkflowName,
  getCompatibilityDate,
  ConfigValidationError,
} from "../lib/load-project-config.js";

interface DevOptions {
  port?: number;
  local?: boolean;
}

interface StateFile {
  version: number;
  projectName: string;
  cloudflare: {
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

async function saveState(projectDir: string, state: StateFile): Promise<void> {
  const statePath = path.join(projectDir, ".clawflare", "state.json");
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, JSON.stringify(state, null, 2));
}

async function getLocalD1DatabaseName(projectName: string): Promise<string> {
  return `${projectName}-local`;
}

async function ensureLocalD1Database(dbName: string): Promise<void> {
  try {
    const output = execSync("wrangler d1 list --json", { encoding: "utf-8" });
    const databases = JSON.parse(output) as Array<{ name: string; uuid: string }>;
    const exists = databases.some((db) => db.name === dbName);

    if (!exists) {
      console.log(`Creating local D1 database "${dbName}"...`);
      execSync(`wrangler d1 create "${dbName}" --json`, { stdio: "pipe" });
      console.log("  Created database\n");
    }
  } catch {
    // Database may already exist, that's fine
  }
}

async function applyLocalMigrations(dbName: string, configPath: string): Promise<void> {
  try {
    console.log("Applying local D1 migrations...");
    execSync(`wrangler d1 migrations apply "${dbName}" --local --config "${configPath}"`, {
      stdio: "inherit",
    });
    console.log("  Migrations applied\n");
  } catch (error) {
    console.warn(`  Warning: Could not apply migrations: ${error}`);
  }
}

export async function devCommand(options: DevOptions): Promise<void> {
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
  const projectName = config.name;
  const workerName = getWorkerName(config);
  const workflowName = getWorkflowName(config);
  const compatibilityDate = getCompatibilityDate(config);

  console.log(`Starting Clawflare development server for "${projectName}"...\n`);

  // Load or create state with full structure
  let state: StateFile;
  const existingState = await loadState(cwd);
  if (existingState) {
    state = existingState;
  } else {
    state = {
      version: 1,
      projectName,
      cloudflare: {},
    };
  }
  state.projectName = projectName;

  // Set up local D1 database
  const dbName = await getLocalD1DatabaseName(projectName);
  await ensureLocalD1Database(dbName);

  state.cloudflare.d1DatabaseName = dbName;
  await saveState(cwd, state);

  // Always regenerate Wrangler config for dev (inputs may have changed)
  console.log("Generating Wrangler configuration...");
  const wranglerPath = path.join(cwd, ".clawflare", "wrangler.jsonc");
  await generateWranglerConfig({
    projectDir: cwd,
    projectName,
    dbName,
    workerName,
    workflowName,
    compatibilityDate,
  });
  console.log(`  Config: ${wranglerPath}\n`);

  // Apply migrations
  await applyLocalMigrations(dbName, wranglerPath);

  console.log("Starting Wrangler dev server...\n");

  // Build args for wrangler dev
  const args = ["dev", "--config", wranglerPath];

  if (options.port) {
    args.push("--port", options.port.toString());
  }

  if (options.local) {
    args.push("--local");
  }

  // Print helpful info
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  Development server starting...");
  console.log("  ");
  console.log("  Once ready, open another terminal and run:");
  console.log("    clawflare open --local");
  console.log("  ");
  console.log("  Or use the direct URL with --host:");
  console.log("    clawflare open --host http://localhost:8787 --token <token>");
  console.log("═══════════════════════════════════════════════════════════════\n");

  // Spawn wrangler dev
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
