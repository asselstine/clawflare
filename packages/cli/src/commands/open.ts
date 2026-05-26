/**
 * Clawflare CLI - open command
 * Opens the TUI for an agent session
 */

import { AgentClient } from "../client.js";
import { createTUI } from "../tui-app.js";
import { loadConfig } from "./login.js";
import { DEFAULT_SERVER } from "../constants.js";

interface OpenOptions {
  server?: string;
  token?: string;
  workspace?: string;
}

export async function openCommand(options: OpenOptions): Promise<void> {
  // Priority: 1) CLI options, 2) saved config, 3) env vars, 4) defaults
  const config = await loadConfig();
  
  let server = options.server || config.server || process.env.CLAWFLARE_URL;
  let token = options.token || config.token || process.env.CLAWFLARE_API_TOKEN;
  let workspace = options.workspace || config.workspace || process.env.CLAWFLARE_WORKSPACE;
  
  // Default to hosted service if no server specified
  if (!server) {
    server = DEFAULT_SERVER;
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
