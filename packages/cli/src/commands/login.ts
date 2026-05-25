/**
 * Clawflare CLI - login command
 * Authenticate the CLI with the Clawflare server using GitHub OAuth
 */

import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { spawn } from "child_process";

// =============================================================================
// Types
// =============================================================================

export interface AuthConfig {
  server?: string;
  token?: string;
  workspace?: string;
  authProvider?: "github";
  user?: {
    id: string;
    email?: string;
    displayName?: string;
  };
  currentWorkspace?: {
    id: string;
    slug: string;
    name: string;
    role?: string;
  };
  tokenCreatedAt?: number;
}

interface DeviceStartResponse {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  authorizationUrl?: string;
  expiresIn: number;
  interval: number;
}

type DevicePollResponse =
  | { status: "pending" }
  | { status: "denied"; message?: string }
  | { status: "expired"; message?: string }
  | {
      status: "complete";
      accessToken?: string;
      user?: {
        id: string;
        email?: string;
        displayName?: string;
      };
    };

interface MeResponse {
  user: {
    id: string;
    email: string;
    displayName?: string;
    createdAt: number;
  };
  workspaces: Array<{
    id: string;
    slug: string;
    name: string;
    description?: string;
    role?: string;
  }>;
  currentWorkspace: {
    id: string;
    slug: string;
    name: string;
    role: string;
  };
}

interface LoginOptions {
  server?: string;
  provider?: "github";
  open?: boolean;
  timeout?: number;
}

interface LogoutOptions {
  all?: boolean;
  server?: string;
}

// =============================================================================
// Config File Management
// =============================================================================

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

export async function loadConfig(): Promise<AuthConfig> {
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
  const tmpPath = `${configPath}.tmp`;
  
  // Write to temp file first, then rename for atomic update
  await fs.writeFile(tmpPath, JSON.stringify(config, null, 2), { 
    encoding: "utf-8",
    mode: 0o600 // Restrictive permissions (owner read/write only)
  });
  await fs.rename(tmpPath, configPath);
}

async function deleteConfig(): Promise<void> {
  try {
    const configPath = await getConfigPath();
    await fs.unlink(configPath);
  } catch {
    // Ignore errors (file may not exist)
  }
}

// =============================================================================
// HTTP Helpers
// =============================================================================

async function requestJson<T>(
  server: string,
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const url = new URL(path, server).toString();
  const response = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
  
  const text = await response.text();
  
  if (!response.ok) {
    let errorMessage: string;
    try {
      const errorJson = JSON.parse(text) as { error?: string; message?: string };
      errorMessage = errorJson.error || errorJson.message || `HTTP ${response.status}`;
    } catch {
      errorMessage = `HTTP ${response.status}: ${text.slice(0, 100)}`;
    }
    throw new Error(errorMessage);
  }
  
  if (!text) {
    return {} as T;
  }
  
  return JSON.parse(text) as T;
}

async function authenticatedRequestJson<T>(
  server: string,
  token: string,
  path: string,
  init: RequestInit = {}
): Promise<T> {
  return requestJson<T>(server, path, {
    ...init,
    headers: {
      "Authorization": `Bearer ${token}`,
      ...init.headers,
    },
  });
}

// =============================================================================
// Browser Opener
// =============================================================================

async function openBrowser(url: string): Promise<boolean> {
  const platform = process.platform;
  
  let command: string;
  let args: string[];
  
  if (platform === "darwin") {
    command = "open";
    args = [url];
  } else if (platform === "win32") {
    command = "cmd";
    args = ["/c", "start", "", url];
  } else {
    // Linux and other Unix-like systems
    command = "xdg-open";
    args = [url];
  }
  
  return new Promise((resolve) => {
    try {
      const child = spawn(command, args, {
        stdio: "ignore",
        detached: true,
      });
      
      child.on("error", () => {
        resolve(false);
      });
      
      child.on("spawn", () => {
        resolve(true);
      });
      
      // Timeout if browser doesn't open
      setTimeout(() => resolve(false), 5000);
    } catch {
      resolve(false);
    }
  });
}

// =============================================================================
// Device Authorization Polling
// =============================================================================

async function pollDeviceAuthorization(
  server: string,
  deviceCode: string,
  intervalSeconds: number,
  timeoutSeconds: number
): Promise<{ accessToken: string; user?: { id: string; email?: string; displayName?: string } }> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  const intervalMs = intervalSeconds * 1000;
  
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (Date.now() >= deadline) {
      throw new Error("Login timed out");
    }
    
    const result = await requestJson<DevicePollResponse>(server, "/v1/auth/device/poll", {
      method: "POST",
      body: JSON.stringify({ deviceCode }),
    });
    
    if (result.status === "complete") {
      if (!result.accessToken) {
        throw new Error("Device authorization completed but no access token was returned. Please try again.");
      }
      return {
        accessToken: result.accessToken,
        user: result.user,
      };
    }
    
    if (result.status === "denied") {
      throw new Error("Device authorization was denied");
    }
    
    if (result.status === "expired") {
      throw new Error("Device code expired. Please run 'clawflare login' again.");
    }
    
    // Pending - wait and poll again
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}

// =============================================================================
// Commands
// =============================================================================

export async function loginCommand(options: LoginOptions): Promise<void> {
  // Resolve server
  const server = options.server?.replace(/\/$/, "") || "https://app.clawflare.dev";
  const timeout = options.timeout ?? 600; // Default 10 minutes
  
  console.log(`Authenticating with ${server}...\n`);
  
  // Start device authorization
  console.log("Starting GitHub OAuth device flow...");
  
  let deviceStart: DeviceStartResponse;
  try {
    deviceStart = await requestJson<DeviceStartResponse>(server, "/v1/auth/device/start", {
      method: "POST",
      body: JSON.stringify({
        clientName: "Clawflare CLI",
        provider: options.provider || "github",
      }),
    });
  } catch (error) {
    if (error instanceof Error) {
      console.error(`Failed to start device authorization: ${error.message}`);
    } else {
      console.error("Failed to start device authorization");
    }
    process.exit(1);
  }
  
  // Display codes and instructions
  console.log("┌─────────────────────────────────────────────────────────┐");
  console.log("│  Device Code                                            │");
  console.log(`│  ${deviceStart.userCode.padEnd(55)}│`);
  console.log("└─────────────────────────────────────────────────────────┘\n");
  
  if (deviceStart.authorizationUrl) {
    console.log(`Opening browser to: ${deviceStart.authorizationUrl}\n`);
    
    let browserOpened = false;
    if (options.open !== false) {
      browserOpened = await openBrowser(deviceStart.authorizationUrl);
    }
    
    if (!browserOpened) {
      console.log("Please open this URL in your browser:");
      console.log(`  ${deviceStart.authorizationUrl}\n`);
      console.log(`After authorizing, the CLI will automatically detect completion.\n`);
    }
  } else {
    console.log("GitHub OAuth is not configured on this server.");
    console.log(`Please visit: ${deviceStart.verificationUrl}\n`);
  }
  
  // Poll for completion
  console.log("Waiting for browser authentication...");
  
  let authResult: { accessToken: string; user?: { id: string; email?: string; displayName?: string } };
  try {
    authResult = await pollDeviceAuthorization(
      server,
      deviceStart.deviceCode,
      deviceStart.interval,
      Math.min(timeout, deviceStart.expiresIn)
    );
  } catch (error) {
    console.error(`\n${error instanceof Error ? error.message : "Login failed"}`);
    process.exit(1);
  }
  
  console.log("✓ Authentication successful\n");
  
  // Get user info from /v1/me
  console.log("Fetching user information...");
  
  let me: MeResponse;
  try {
    me = await authenticatedRequestJson<MeResponse>(
      server,
      authResult.accessToken,
      "/v1/me"
    );
  } catch (error) {
    if (error instanceof Error && error.message.includes("401")) {
      console.error("Stored token is invalid or expired. Please try again.");
    } else {
      console.error(`Failed to get user info: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
    process.exit(1);
  }
  
  // Save config
  const config: AuthConfig = {
    server,
    token: authResult.accessToken,
    authProvider: "github",
    user: {
      id: me.user.id,
      email: me.user.email,
      displayName: me.user.displayName,
    },
    currentWorkspace: me.currentWorkspace,
    workspace: me.currentWorkspace.slug,
    tokenCreatedAt: Date.now(),
  };
  
  await saveConfig(config);
  
  // Display success
  console.log("✓ Logged in successfully\n");
  console.log(`User:     ${me.user.displayName || me.user.email} (${me.user.email})`);
  console.log(`Workspace: ${me.currentWorkspace.name} (${me.currentWorkspace.slug})`);
  console.log(`Server:   ${server}\n`);
  console.log("Run 'clawflare open' to start the Clawflare TUI.");
}

export async function logoutCommand(options: LogoutOptions): Promise<void> {
  const config = await loadConfig();
  
  if (!config.token) {
    console.log("Not logged in.");
    return;
  }
  
  const server = options.server || config.server || "https://app.clawflare.dev";
  
  // Try to revoke server-side (best effort)
  try {
    await authenticatedRequestJson<{ success?: boolean }>(
      server,
      config.token,
      "/v1/auth/logout",
      { method: "POST" }
    );
    console.log("Server token revoked.");
  } catch (error) {
    if (error instanceof Error && error.message.includes("401")) {
      console.log("Stored token was already invalid or expired.");
    } else {
      console.log("Could not reach server; removing local token anyway.");
    }
  }
  
  // Remove local token
  if (options.all) {
    // Delete entire config
    await deleteConfig();
    console.log("Configuration deleted.");
  } else {
    // Preserve server and other non-secret preferences
    const newConfig: AuthConfig = {
      server: config.server,
    };
    await saveConfig(newConfig);
  }
  
  console.log("Logged out.");
}

export async function whoamiCommand(): Promise<void> {
  const config = await loadConfig();
  
  if (!config.server) {
    console.log("Server: https://app.clawflare.dev (default)");
  } else {
    console.log(`Server: ${config.server}`);
  }
  
  if (!config.token) {
    console.log("\nNot logged in. Run 'clawflare login' to authenticate.");
    return;
  }
  
  const server = config.server || "https://app.clawflare.dev";
  
  try {
    const me = await authenticatedRequestJson<MeResponse>(
      server,
      config.token,
      "/v1/me"
    );
    
    console.log(`\nUser:      ${me.user.displayName || me.user.email}`);
    console.log(`Email:     ${me.user.email}`);
    console.log(`Workspace: ${me.currentWorkspace.name} (${me.currentWorkspace.slug})`);
    
    // Also update cached info
    const updatedConfig: AuthConfig = {
      ...config,
      user: {
        id: me.user.id,
        email: me.user.email,
        displayName: me.user.displayName,
      },
      currentWorkspace: me.currentWorkspace,
      workspace: me.currentWorkspace.slug,
    };
    await saveConfig(updatedConfig);
  } catch (error) {
    if (error instanceof Error && error.message.includes("401")) {
      console.log("\nStored token is invalid or expired.");
      console.log("Run 'clawflare login' to re-authenticate.");
    } else {
      // Show cached info if available
      if (config.user) {
        console.log(`\nUser:      ${config.user.displayName || config.user.email || "Unknown"}`);
        if (config.user.email) {
          console.log(`Email:     ${config.user.email}`);
        }
      }
      if (config.currentWorkspace) {
        console.log(`Workspace: ${config.currentWorkspace.name} (${config.currentWorkspace.slug})`);
      }
      console.log("\nWarning: Could not reach server to verify current status.");
    }
  }
}
