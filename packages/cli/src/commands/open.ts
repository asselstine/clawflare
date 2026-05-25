/**
 * Clawflare CLI - open command
 * Opens the TUI for an agent session
 */

import { AgentClient } from "../client.js";
import { createTUI } from "../tui-app.js";
import { loadConfig } from "./login.js";

interface OpenOptions {
  server?: string;
  token?: string;
  workspace?: string;
}

export async function openCommand(options: OpenOptions): Promise<void> {
  // Priority: 1) CLI options, 2) env vars, 3) saved config, 4) defaults
  let server = options.server || process.env.CLAWFLARE_URL;
  let token = options.token || process.env.CLAWFLARE_API_TOKEN;
  let workspace = options.workspace || process.env.CLAWFLARE_WORKSPACE;
  
  // Try loading from saved config
  if (!server || !token || !workspace) {
    const config = await loadConfig();
    if (!server) {
      server = config.server;
    }
    if (!token) {
      token = config.token;
    }
    if (!workspace) {
      workspace = config.workspace;
    }
  }
  
  // Default to hosted service if no server specified
  if (!server) {
    server = "https://app.clawflare.dev";
  }
  
  if (!token) {
    console.error("Error: Not authenticated. Please run 'clawflare login' to authenticate.");
    console.error("\nAlternatively, you can provide a token explicitly:");
    console.error("  clawflare open --token <token>");
    console.error("  CLAWFLARE_API_TOKEN=<token> clawflare open");
    console.error("\nFor self-hosted:");
    console.error("  clawflare open --server http://localhost:8787 --token <token>");
    process.exit(1);
  }

  console.log(`Connecting to ${server}...`);
  
  const client = new AgentClient(server, token, workspace);
  const app = createTUI(client);
  app.start();
}
