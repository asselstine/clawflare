/**
 * Clawflare CLI - login command
 * Authenticate the CLI with the Clawflare server
 */

import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";

interface LoginOptions {
  server?: string;
}

interface AuthConfig {
  server?: string;
  token?: string;
}

function getConfigDir(): string {
  const home = os.homedir();
  const configDir = process.platform === "win32"
    ? path.join(home, "AppData", "Roaming", "clawflare")
    : process.platform === "darwin"
    ? path.join(home, "Library", "Application Support", "clawflare")
    : path.join(home, ".config", "clawflare");
  return configDir;
}

async function getConfigPath(): Promise<string> {
  const configDir = getConfigDir();
  await fs.mkdir(configDir, { recursive: true });
  return path.join(configDir, "config.json");
}

async function loadConfig(): Promise<AuthConfig> {
  try {
    const configPath = await getConfigPath();
    const content = await fs.readFile(configPath, "utf-8");
    return JSON.parse(content) as AuthConfig;
  } catch {
    return {};
  }
}

async function saveConfig(config: AuthConfig): Promise<void> {
  const configPath = await getConfigPath();
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf-8");
}

export async function loginCommand(options: LoginOptions): Promise<void> {
  const server = options.server || "https://app.clawflare.dev";
  
  // For Phase 1: Stub implementation that stores server URL
  // TODO: Implement server-mediated OAuth flow in Phase 7
  console.log(`Clawflare authentication (Phase 1 stub)`);
  console.log(`\nServer URL: ${server}`);
  console.log("\nNote: Full OAuth authentication not yet implemented.");
  console.log("Use --token with 'clawflare open' or set CLAWFLARE_API_TOKEN env var.");
  
  // Store the server URL for future use
  const config = await loadConfig();
  config.server = server;
  await saveConfig(config);
  
  console.log("\nServer URL saved. Run 'clawflare open' to connect.");
}

export async function logoutCommand(): Promise<void> {
  try {
    const configPath = await getConfigPath();
    await fs.unlink(configPath);
    console.log("Logged out. Authentication cleared.");
  } catch {
    console.log("No active session found.");
  }
}

export async function whoamiCommand(): Promise<void> {
  // For Phase 1: Stub implementation
  // TODO: Implement actual user lookup in Phase 7
  const config = await loadConfig();
  
  if (config.server) {
    console.log(`Server: ${config.server}`);
    console.log("Status: Not authenticated (Phase 1 stub)");
    console.log("\nNote: Full user authentication not yet implemented.");
  } else {
    console.log("Not logged in. Run 'clawflare login' to authenticate.");
  }
}

// Export config helpers for other commands
export { getConfigPath, loadConfig, saveConfig };
export type { AuthConfig };
