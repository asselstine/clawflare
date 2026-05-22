/**
 * Clawflare CLI - dev command
 * Start local development server
 */

import { execSync, spawn } from "child_process";
import * as fs from "fs/promises";
import * as path from "path";
import { generateWranglerConfig } from "./config.js";

interface DevOptions {
  port?: number;
  local?: boolean;
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

async function saveState(projectDir: string, state: StateFile): Promise<void> {
  const statePath = path.join(projectDir, ".clawflare", "state.json");
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, JSON.stringify(state, null, 2));
}

async function loadConfig(projectDir: string): Promise<{ name: string; cloudflare?: { compatibilityDate?: string } } | null> {
  try {
    const configPath = path.join(projectDir, "clawflare.config.ts");
    await fs.access(configPath);
    const pkgPath = path.join(projectDir, "package.json");
    const pkgContent = await fs.readFile(pkgPath, "utf-8");
    const pkg = JSON.parse(pkgContent);
    return { name: pkg.name };
  } catch {
    return null;
  }
}

async function getLocalD1DatabaseName(projectName: string): Promise<string> {
  return `${projectName}-local`;
}

async function ensureLocalD1Database(dbName: string): Promise<void> {
  try {
    // Check if database exists by listing
    const output = execSync("wrangler d1 list --json", { encoding: "utf-8" });
    const databases = JSON.parse(output) as Array<{ name: string; uuid: string }>;
    const exists = databases.some((db) => db.name === dbName);
    
    if (!exists) {
      console.log(`Creating local D1 database "${dbName}"...`);
      execSync(`wrangler d1 create "${dbName}" --json`, { stdio: "pipe" });
      console.log(`  Created database\n`);
    }
  } catch {
    // Database may already exist, that's fine
  }
}

async function applyLocalMigrations(dbName: string): Promise<void> {
  try {
    console.log("Applying local D1 migrations...");
    execSync(`wrangler d1 migrations apply "${dbName}" --local`, { stdio: "inherit" });
    console.log("  Migrations applied\n");
  } catch (error) {
    console.warn(`  Warning: Could not apply migrations: ${error}`);
  }
}

export async function devCommand(options: DevOptions): Promise<void> {
  const cwd = process.cwd();
  
  // Check for project structure
  const config = await loadConfig(cwd);
  if (!config) {
    console.error("Error: No Clawflare project found in current directory");
    console.error("Run 'clawflare init <name>' to create a new project");
    process.exit(1);
  }

  console.log(`Starting Clawflare development server for "${config.name}"...\n`);

  // Load or create state
  let state = await loadState(cwd) || { version: 1, projectName: config.name };
  state.projectName = config.name;
  
  if (!state.cloudflare) state.cloudflare = {};

  // Set up local D1 database
  const dbName = await getLocalD1DatabaseName(config.name);
  await ensureLocalD1Database(dbName);
  
  state.cloudflare.d1DatabaseName = dbName;
  await saveState(cwd, state);

  // Generate Wrangler config if it doesn't exist
  const wranglerPath = path.join(cwd, ".clawflare", "wrangler.jsonc");
  try {
    await fs.access(wranglerPath);
  } catch {
    console.log("Generating Wrangler configuration...");
    await generateWranglerConfig({
      projectDir: cwd,
      projectName: config.name,
      dbName,
      workerName: config.name,
      compatibilityDate: config.cloudflare?.compatibilityDate || "2025-01-01",
    });
    console.log(`  Config: ${wranglerPath}\n`);
  }

  // Apply migrations
  await applyLocalMigrations(dbName);

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
