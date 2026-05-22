/**
 * Clawflare CLI - deploy command
 * Deploys the project to Cloudflare
 */

import { execSync, spawn } from "child_process";
import * as fs from "fs/promises";
import * as path from "path";
import * as readline from "readline";
import { generateWranglerConfig } from "./config.js";
import {
  loadConfigFromCwd,
  getWorkerName,
  getDatabaseName,
  getCompatibilityDate,
  getAllSecrets,
  type ClawflareConfig,
  ConfigValidationError,
} from "../lib/load-project-config.js";

export interface DeployOptions {
  env?: string;
  printConfig?: boolean;
  force?: boolean;
  accountId?: string;
}

interface CloudflareState {
  accountId: string;
  workerName: string;
  d1DatabaseName: string;
  d1DatabaseId: string;
}

interface StateFile {
  version: number;
  projectName: string;
  cloudflare: CloudflareState;
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
    process.stderr.write(`Enter value for ${name}${desc}: `);
    rl.question("", (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function getCloudflareAccounts(): Promise<Array<{ id: string; name: string }>> {
  const accounts: Array<{ id: string; name: string }> = [];

  try {
    const result = execSync("wrangler whoami", { encoding: "utf-8" });
    const match = result.match(/Account ID\s+([a-f0-9]+)/i);
    if (match) {
      const id = match[1];
      const nameMatch = result.match(/Account Name\s+(.+)/i);
      const name = nameMatch ? nameMatch[1].trim() : id;
      accounts.push({ id, name });
    }
  } catch {
    // Ignore
  }

  const configPath = path.join(process.env.HOME || "", ".wrangler", "config.json");
  try {
    const configContent = await fs.readFile(configPath, "utf-8");
    const config = JSON.parse(configContent);
    if (config.accounts && Array.isArray(config.accounts)) {
      for (const account of config.accounts) {
        if (account.id && !accounts.find((a) => a.id === account.id)) {
          accounts.push({
            id: account.id,
            name: account.name || account.id,
          });
        }
      }
    }
  } catch {
    // Ignore
  }

  return accounts;
}

async function getCloudflareAccountId(options?: { forceAccountId?: string }): Promise<string | null> {
  const isInteractive = process.stdin.isTTY;

  if (options?.forceAccountId) {
    return options.forceAccountId;
  }

  if (process.env.CLOUDFLARE_ACCOUNT_ID) {
    return process.env.CLOUDFLARE_ACCOUNT_ID;
  }

  const accounts = await getCloudflareAccounts();

  if (accounts.length === 0) {
    return null;
  }

  if (accounts.length === 1) {
    return accounts[0].id;
  }

  // Multiple accounts
  if (!isInteractive) {
    console.error("Multiple Cloudflare accounts found. Set CLOUDFLARE_ACCOUNT_ID or use --account-id.");
    console.error("Available accounts:");
    accounts.forEach((acc) => {
      console.error(`  ${acc.name} (${acc.id})`);
    });
    return null;
  }

  console.log("Multiple Cloudflare accounts found:");
  accounts.forEach((acc, i) => {
    console.log(`  ${i + 1}. ${acc.name} (${acc.id})`);
  });

  const choice = await prompt("\nSelect account (number): ");
  const index = parseInt(choice, 10) - 1;
  if (index >= 0 && index < accounts.length) {
    return accounts[index].id;
  }

  console.error("Invalid selection. Please run again with --account-id.");
  return null;
}

async function checkCloudflareAuth(): Promise<boolean> {
  try {
    if (process.env.CLOUDFLARE_API_TOKEN) {
      return true;
    }
    execSync("wrangler whoami", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

async function createD1Database(name: string): Promise<{ uuid: string }> {
  try {
    const result = execSync(`wrangler d1 create "${name}" --json`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const parsed = JSON.parse(result);
    return { uuid: parsed.uuid };
  } catch (error) {
    // Try to find existing
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

async function verifyD1Database(databaseId: string): Promise<{ name: string; uuid: string } | null> {
  try {
    const listResult = execSync("wrangler d1 list --json", { encoding: "utf-8" });
    const databases = JSON.parse(listResult) as Array<{ name: string; uuid: string }>;
    return databases.find((db) => db.uuid === databaseId) || null;
  } catch {
    return null;
  }
}

/**
 * Set a secret using wrangler secret put with stdin to avoid shell escaping issues
 */
async function setSecret(secretName: string, value: string, wranglerPath: string): Promise<boolean> {
  // Use spawned process with stdin for safer secret handling
  return new Promise((resolve) => {
    const child = spawn(
      "wrangler",
      ["secret", "put", secretName, "--config", wranglerPath],
      { stdio: ["pipe", "pipe", "pipe"] }
    );

    child.stdin.write(value);
    child.stdin.end();

    let errorOutput = "";
    child.stderr?.on("data", (data) => {
      errorOutput += data.toString();
    });

    child.on("close", (code) => {
      if (code !== 0 && errorOutput.includes("already exists")) {
        resolve(true); // Secret already exists is OK
      } else {
        resolve(code === 0);
      }
    });

    child.on("error", () => {
      resolve(false);
    });
  });
}

export async function deployCommand(options: DeployOptions): Promise<void> {
  const cwd = process.cwd();
  const isInteractive = process.stdin.isTTY;

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
  const workerName = getWorkerName(config, options.env);
  const dbName = getDatabaseName(config, options.env);
  const compatibilityDate = getCompatibilityDate(config);

  console.log(`Deploying "${projectName}"${options.env ? ` [${options.env}]` : ""}...\n`);

  // Load or create state with full structure
  let state: StateFile;
  const existingState = await loadState(cwd);
  if (existingState) {
    state = existingState;
  } else {
    state = {
      version: 1,
      projectName,
      cloudflare: {
        accountId: "",
        workerName: "",
        d1DatabaseName: "",
        d1DatabaseId: "",
      },
    };
  }
  state.projectName = projectName;

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

  state.cloudflare.accountId = accountId;
  state.cloudflare.workerName = workerName;
  state.cloudflare.d1DatabaseName = dbName;

  console.log(`  Account: ${accountId}\n`);

  // Create or verify D1 database
  let dbId = state.cloudflare.d1DatabaseId;

  if (dbId && !options.force) {
    // Verify existing database
    console.log(`Verifying D1 database "${dbName}"...`);
    const existing = await verifyD1Database(dbId);
    if (existing) {
      console.log(`  Database ID: ${dbId} (verified)\n`);
    } else {
      console.log(`  Database ${dbId} not found, creating new one...`);
      dbId = "";
    }
  }

  if (!dbId) {
    console.log(`Creating D1 database "${dbName}"...`);
    try {
      const db = await createD1Database(dbName);
      dbId = db.uuid;
      state.cloudflare.d1DatabaseId = dbId;
      console.log(`  Database ID: ${dbId}\n`);
    } catch (error) {
      console.error(`  Error creating database: ${error}`);
      process.exit(1);
    }
  }

  // Generate Wrangler config
  console.log("Generating Wrangler configuration...");
  const wranglerPath = await generateWranglerConfig({
    projectDir: cwd,
    projectName,
    dbId,
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
    execSync(`wrangler d1 migrations apply "${dbName}" --remote --config "${wranglerPath}"`, {
      stdio: "inherit",
    });
    console.log("  Migrations applied\n");
  } catch (error) {
    console.error(`  Error applying migrations: ${error}`);
  }

  // Set secrets
  console.log("Checking and setting secrets...\n");

  const secretDefs = getAllSecrets(config);
  const missingSecrets: string[] = [];

  for (const def of secretDefs) {
    let value = process.env[def.name];

    if (!value && isInteractive && def.required) {
      console.log(`Secret ${def.name} is required.`);
      value = await promptSecret(def.name, def.description);
    }

    if (value) {
      console.log(`  Setting secret: ${def.name}`);
      const success = await setSecret(def.name, value, wranglerPath);
      if (success) {
        console.log(`    ✓ Secret set`);
      } else {
        console.log(`    (may already exist)`);
      }
    } else if (def.required) {
      missingSecrets.push(def.name);
      console.warn(`  Warning: Required secret ${def.name} not set`);
    }
  }

  if (missingSecrets.length > 0 && !isInteractive) {
    console.error(`\nError: Missing required secrets: ${missingSecrets.join(", ")}`);
    console.error("Set them via environment variables and retry, or run interactively.");
    process.exit(1);
  }

  // Deploy Worker
  console.log("\nDeploying Worker...");
  try {
    const child = spawn("wrangler", ["deploy", "--config", wranglerPath], {
      stdio: "inherit",
    });

    await new Promise<void>((resolve, reject) => {
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`wrangler deploy exited with code ${code}`));
      });
      child.on("error", reject);
    });
  } catch (error) {
    console.error(`\nError deploying: ${error}`);
    process.exit(1);
  }

  // Get deployment URL
  console.log("\nGetting deployment URL...");
  let deploymentUrl: string | undefined;
  try {
    const result = execSync(`wrangler deployment list --config "${wranglerPath}" --json`, {
      encoding: "utf-8",
    });
    const deployments = JSON.parse(result) as Array<{ url: string }>;
    if (deployments.length > 0 && deployments[0].url) {
      deploymentUrl = deployments[0].url;
      console.log(`  URL: ${deploymentUrl}`);
    }
  } catch {
    deploymentUrl = `https://${workerName}.${accountId}.workers.dev`;
    console.log(`  URL: ${deploymentUrl} (inferred)`);
  }

  // Update state
  state.deployment = {
    url: deploymentUrl,
    lastDeployedAt: new Date().toISOString(),
  };
  await saveState(cwd, state);

  console.log("\n✓ Deployment complete!");
  if (deploymentUrl) {
    console.log(`\nYour agent is available at: ${deploymentUrl}`);
  }
  console.log("\nNext steps:");
  console.log("  clawflare open");
}
