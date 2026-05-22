/**
 * Clawflare CLI - deploy command
 * Deploys the project to Cloudflare
 */

import { execSync, spawn } from "child_process";
import * as fs from "fs/promises";
import * as path from "path";
import * as readline from "readline";
import { generateWranglerConfig } from "./config.js";

export interface DeployOptions {
  env?: string;
  printConfig?: boolean;
  force?: boolean;
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

interface ClawflareConfig {
  name: string;
  ai?: {
    provider?: string;
    model?: string;
  };
  cloudflare?: {
    compatibilityDate?: string;
    workerName?: string;
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

async function loadConfig(projectDir: string): Promise<ClawflareConfig | null> {
  try {
    // This is a simplified version - in production we'd need to transpile TypeScript
    const configPath = path.join(projectDir, "clawflare.config.ts");
    await fs.access(configPath);
    // For now, extract name from package.json
    const pkgPath = path.join(projectDir, "package.json");
    const pkgContent = await fs.readFile(pkgPath, "utf-8");
    const pkg = JSON.parse(pkgContent);
    return { name: pkg.name };
  } catch {
    return null;
  }
}

async function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function getCloudflareAccountId(): Promise<string | null> {
  try {
    const result = execSync("wrangler whoami", { encoding: "utf-8" });
    // Try to extract account ID from wrangler output
    const match = result.match(/Account ID\s+([a-f0-9]+)/i);
    if (match) return match[1];
    
    // Try reading from .wrangler/config.json
    const configPath = path.join(process.env.HOME || "", ".wrangler", "config.json");
    try {
      const configContent = await fs.readFile(configPath, "utf-8");
      const config = JSON.parse(configContent);
      // There might be multiple accounts, return the first one
      if (config.accounts && config.accounts.length > 0) {
        return config.accounts[0].id;
      }
    } catch {
      // Ignore errors reading config
    }
    
    return null;
  } catch {
    return null;
  }
}

async function createD1Database(name: string): Promise<{ uuid: string }> {
  try {
    const result = execSync(
      `wrangler d1 create "${name}" --json`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
    );
    const parsed = JSON.parse(result);
    return { uuid: parsed.uuid };
  } catch (error) {
    // Database might already exist
    try {
      const listResult = execSync("wrangler d1 list --json", { encoding: "utf-8" });
      const databases = JSON.parse(listResult) as Array<{ name: string; uuid: string }>;
      const existing = databases.find((db) => db.name === name);
      if (existing) {
        return { uuid: existing.uuid };
      }
    } catch {
      // Ignore
    }
    throw error;
  }
}

export async function deployCommand(options: DeployOptions): Promise<void> {
  const cwd = process.cwd();
  
  // Check for project structure
  const config = await loadConfig(cwd);
  if (!config) {
    console.error("Error: No Clawflare project found in current directory");
    console.error("Run 'clawflare init <name>' to create a new project");
    process.exit(1);
  }

  console.log(`Deploying "${config.name}"...\n`);

  // Load or create state
  let state = await loadState(cwd) || { version: 1, projectName: config.name };
  state.projectName = config.name;

  // Check Cloudflare auth
  console.log("Checking Cloudflare authentication...");
  const accountId = await getCloudflareAccountId();
  if (!accountId) {
    console.error("Error: Not authenticated with Cloudflare");
    console.error("Run 'wrangler login' or set CLOUDFLARE_API_TOKEN");
    process.exit(1);
  }
  
  if (!state.cloudflare) state.cloudflare = {};
  state.cloudflare.accountId = accountId;
  
  console.log(`  Account: ${accountId}\n`);

  // Create or use D1 database
  const dbName = options.env ? `${config.name}-${options.env}` : config.name;
  state.cloudflare.d1DatabaseName = dbName;
  state.cloudflare.workerName = dbName;

  if (!state.cloudflare.d1DatabaseId || options.force) {
    console.log(`Creating D1 database "${dbName}"...`);
    try {
      const db = await createD1Database(dbName);
      state.cloudflare.d1DatabaseId = db.uuid;
      console.log(`  Database ID: ${db.uuid}\n`);
    } catch (error) {
      console.error(`  Error creating database: ${error}`);
      process.exit(1);
    }
  } else {
    console.log(`Using existing D1 database: ${state.cloudflare.d1DatabaseId}\n`);
  }

  // Generate Wrangler config using the shared generator
  console.log("Generating Wrangler configuration...");
  const compatibilityDate = config.cloudflare?.compatibilityDate || "2025-01-01";
  const wranglerPath = await generateWranglerConfig({
    projectDir: cwd,
    projectName: config.name,
    dbId: state.cloudflare.d1DatabaseId,
    dbName,
    workerName: dbName,
    accountId,
    compatibilityDate,
  });
  console.log(`  Config: ${wranglerPath}\n`);

  if (options.printConfig) {
    console.log("--- Generated Wrangler Config ---");
    const configContent = await fs.readFile(wranglerPath, "utf-8");
    console.log(configContent);
    console.log("---------------------------------\n");
    return;
  }

  // Apply migrations
  console.log("Applying D1 migrations...");
  try {
    execSync(
      `wrangler d1 migrations apply "${dbName}" --remote --config "${wranglerPath}"`,
      { stdio: "inherit" }
    );
    console.log("  Migrations applied\n");
  } catch (error) {
    console.error(`  Error applying migrations: ${error}`);
    // Continue anyway - migrations might already be applied
  }

  // Set secrets
  console.log("Checking secrets...");
  const envVars = process.env;
  const secrets: Record<string, string> = {};
  
  // Check for required secrets
  if (envVars.CLAWFLARE_API_TOKEN) {
    secrets["CLAWFLARE_API_TOKEN"] = envVars.CLAWFLARE_API_TOKEN;
  }
  if (envVars.ANTHROPIC_API_KEY) {
    secrets["ANTHROPIC_API_KEY"] = envVars.ANTHROPIC_API_KEY;
  }
  if (envVars.AWS_BEARER_TOKEN_BEDROCK) {
    secrets["AWS_BEARER_TOKEN_BEDROCK"] = envVars.AWS_BEARER_TOKEN_BEDROCK;
  }
  if (envVars.CF_API_TOKEN) {
    secrets["CF_API_TOKEN"] = envVars.CF_API_TOKEN;
  }

  // Deploy secrets
  for (const [key, value] of Object.entries(secrets)) {
    console.log(`  Setting secret: ${key}`);
    try {
      execSync(
        `echo "${value}" | wrangler secret put "${key}" --config "${wranglerPath}"`,
        { stdio: ["pipe", "pipe", "pipe"] }
      );
    } catch {
      // Secret might already exist
    }
  }

  // Deploy Worker
  console.log("\nDeploying Worker...");
  try {
    execSync(`wrangler deploy --config "${wranglerPath}"`, { stdio: "inherit" });
  } catch (error) {
    console.error(`\nError deploying: ${error}`);
    process.exit(1);
  }

  // Get deployment URL
  console.log("\nGetting deployment URL...");
  try {
    const result = execSync(
      `wrangler deployment list --config "${wranglerPath}" --json`,
      { encoding: "utf-8" }
    );
    const deployments = JSON.parse(result) as Array<{ url: string }>;
    if (deployments.length > 0 && deployments[0].url) {
      state.deployment = {
        url: deployments[0].url,
      };
      console.log(`  URL: ${deployments[0].url}`);
    }
  } catch {
    // Try alternative URL format
    const url = `https://${dbName}.${accountId}.workers.dev`;
    state.deployment = { url };
    console.log(`  URL: ${url}`);
  }

  // Save state
  await saveState(cwd, state);

  console.log("\n✓ Deployment complete!");
  console.log(`\nNext steps:`);
  console.log(`  clawflare open`);
}
