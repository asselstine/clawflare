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
  accountId?: string;
}

interface CloudflareAccount {
  id: string;
  name: string;
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

async function promptSecret(name: string, description?: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const desc = description ? ` (${description})` : "";
  return new Promise((resolve) => {
    // Use stderr for prompt to avoid mixing with output
    process.stderr.write(`Enter value for ${name}${desc}: `);
    rl.question("", (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function getCloudflareAccounts(): Promise<CloudflareAccount[]> {
  const accounts: CloudflareAccount[] = [];
  
  try {
    // First try wrangler whoami
    const result = execSync("wrangler whoami", { encoding: "utf-8" });
    const match = result.match(/Account ID\s+([a-f0-9]+)/i);
    if (match) {
      const id = match[1];
      // Try to extract account name
      const nameMatch = result.match(/Account Name\s+(.+)/i);
      const name = nameMatch ? nameMatch[1].trim() : id;
      accounts.push({ id, name });
    }
  } catch {
    // Ignore errors from wrangler whoami
  }

  // Also try reading from .wrangler/config.json
  const configPath = path.join(process.env.HOME || "", ".wrangler", "config.json");
  try {
    const configContent = await fs.readFile(configPath, "utf-8");
    const config = JSON.parse(configContent);
    if (config.accounts && Array.isArray(config.accounts)) {
      for (const account of config.accounts) {
        if (account.id && !accounts.find(a => a.id === account.id)) {
          accounts.push({
            id: account.id,
            name: account.name || account.id,
          });
        }
      }
    }
  } catch {
    // Ignore errors reading config
  }

  return accounts;
}

async function getCloudflareAccountId(options?: { forceAccountId?: string }): Promise<string | null> {
  // If explicit account ID is provided, use it
  if (options?.forceAccountId) {
    return options.forceAccountId;
  }

  // Check environment variable
  if (process.env.CLOUDFLARE_ACCOUNT_ID) {
    return process.env.CLOUDFLARE_ACCOUNT_ID;
  }

  // Get all accounts
  const accounts = await getCloudflareAccounts();
  
  if (accounts.length === 0) {
    return null;
  }
  
  if (accounts.length === 1) {
    return accounts[0].id;
  }

  // Multiple accounts - return the first one with a message
  console.log(`Multiple Cloudflare accounts found:`);
  accounts.forEach((acc, i) => {
    console.log(`  ${i + 1}. ${acc.name} (${acc.id})`);
  });
  console.log(`\nUsing account: ${accounts[0].name} (${accounts[0].id})`);
  console.log(`To use a different account, set CLOUDFLARE_ACCOUNT_ID or use --account-id`);
  
  return accounts[0].id;
}

async function checkCloudflareAuth(): Promise<boolean> {
  try {
    // Check if we have API token in environment
    if (process.env.CLOUDFLARE_API_TOKEN) {
      return true;
    }
    
    // Check if wrangler is authenticated
    execSync("wrangler whoami", { stdio: "pipe" });
    return true;
  } catch {
    return false;
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

  console.log(`Deploying "${config.name}"${options.env ? ` [${options.env}]` : ""}...\n`);

  // Load or create state
  let state = await loadState(cwd) || { version: 1, projectName: config.name };
  state.projectName = config.name;

  // Check Cloudflare auth
  console.log("Checking Cloudflare authentication...");
  const isAuthed = await checkCloudflareAuth();
  if (!isAuthed) {
    console.error("Error: Not authenticated with Cloudflare");
    console.error("Run 'wrangler login' or set CLOUDFLARE_API_TOKEN");
    process.exit(1);
  }

  const accountId = await getCloudflareAccountId({ forceAccountId: options.accountId });
  if (!accountId) {
    console.error("Error: Could not determine Cloudflare account ID");
    console.error("Set CLOUDFLARE_ACCOUNT_ID or use --account-id");
    process.exit(1);
  }
  
  if (!state.cloudflare) state.cloudflare = {};
  state.cloudflare.accountId = accountId;
  
  console.log(`  Account: ${accountId}\n`);

  // Create or use D1 database
  const dbName = options.env ? `${config.name}-${options.env}` : config.name;
  const workerName = options.env ? `${config.name}-${options.env}` : config.name;
  state.cloudflare.d1DatabaseName = dbName;
  state.cloudflare.workerName = workerName;

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
    workerName,
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
  console.log("Checking and setting secrets...\n");
  
  const isInteractive = process.stdin.isTTY;
  
  // Define required secrets
  const secretDefs: Array<{ key: string; description?: string; required: boolean }> = [
    { key: "CLAWFLARE_API_TOKEN", description: "API token for Clawflare authentication", required: true },
    { key: "AWS_BEARER_TOKEN_BEDROCK", description: "AWS bearer token for Bedrock AI", required: false },
    { key: "ANTHROPIC_API_KEY", description: "Anthropic API key for Claude", required: false },
  ];

  for (const def of secretDefs) {
    let value = process.env[def.key];
    
    // If not in env and interactive, prompt
    if (!value && isInteractive && def.required) {
      console.log(`Secret ${def.key} is required.`);
      value = await promptSecret(def.key, def.description);
    }

    if (value) {
      console.log(`  Setting secret: ${def.key}`);
      try {
        execSync(
          `echo "${value}" | wrangler secret put "${def.key}" --config "${wranglerPath}"`,
          { stdio: ["pipe", "pipe", "pipe"] }
        );
      } catch {
        // Secret might already exist
        console.log(`    (already exists or error)`);
      }
    } else if (def.required) {
      console.warn(`  Warning: Required secret ${def.key} not set`);
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
  let deploymentUrl: string | undefined;
  try {
    const result = execSync(
      `wrangler deployment list --config "${wranglerPath}" --json`,
      { encoding: "utf-8" }
    );
    const deployments = JSON.parse(result) as Array<{ url: string }>;
    if (deployments.length > 0 && deployments[0].url) {
      deploymentUrl = deployments[0].url;
      console.log(`  URL: ${deploymentUrl}`);
    }
  } catch {
    // Try alternative URL format
    deploymentUrl = `https://${workerName}.${accountId}.workers.dev`;
    console.log(`  URL: ${deploymentUrl} (inferred)`);
  }

  // Update state with deployment info
  state.deployment = {
    url: deploymentUrl,
    lastDeployedAt: new Date().toISOString(),
  };
  await saveState(cwd, state);

  console.log("\n✓ Deployment complete!");
  if (deploymentUrl) {
    console.log(`\nYour agent is available at: ${deploymentUrl}`);
  }
  console.log(`\nNext steps:`);
  console.log(`  clawflare open`);
}
