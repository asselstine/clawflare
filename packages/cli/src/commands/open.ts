/**
 * Clawflare CLI - open command
 * Opens the TUI for an agent session
 */

import { pathToFileURL } from "node:url";
import { config } from "dotenv";
import { AgentClient } from "../client.js";
import { createTUI } from "../tui-app.js";
import * as fs from "fs/promises";
import * as path from "path";

// Load .env file from project root
config({ path: [".env", "../.env", "../../.env"] });

interface OpenOptions {
  host?: string;
  token?: string;
  local?: boolean;
}

interface StateFile {
  deployment?: {
    url?: string;
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

export async function openCommand(options: OpenOptions): Promise<void> {
  let host = options.host;
  let token = options.token;

  // If --local flag is set, use localhost
  if (options.local && !host) {
    host = "http://localhost:8787";
  }

  // Try to load state from current directory
  if (!host) {
    const cwd = process.cwd();
    const state = await loadState(cwd);
    if (state?.deployment?.url) {
      host = state.deployment.url;
      console.log(`Using deployed URL from state: ${host}`);
    }
  }

  // Fall back to environment variables
  if (!host) {
    host = process.env.CLAWFLARE_URL || "http://localhost:8787";
  }

  if (!token) {
    token = process.env.CLAWFLARE_API_TOKEN || "";
  }

  if (!token) {
    console.error("Error: CLAWFLARE_API_TOKEN required");
    console.error("Usage: --token <token> or CLAWFLARE_API_TOKEN env var");
    console.error("       Or set token in .env file");
    process.exit(1);
  }

  const client = new AgentClient(host, token);
  const app = createTUI(client);
  app.start();
}
