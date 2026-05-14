/**
 * Clawflare CLI - TUI Client
 * 
 * A terminal UI interface for the Clawflare harness.
 */

import { pathToFileURL } from "node:url";
import { config } from "dotenv";
import { AgentClient } from "./client.js";
import { createTUI } from "./tui-app.js";

// Load .env file from project root
config({ path: ["../../.env", "../.env", ".env"] });

// Re-export
export { AgentClient, createTUI };
export * from "./client.js";

// Backward compatibility: runCli function
export async function runCli(url: string, token: string): Promise<void> {
  const client = new AgentClient(url, token);
  const app = createTUI(client);
  app.start();
}

// Handle uncaught errors
process.on("uncaughtException", (err) => {
  console.error("Uncaught error:", err);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
  process.exit(1);
});

// Parse command line arguments
function parseArgs(): { host: string; token: string } {
  const args = process.argv.slice(2);
  
  let host: string | null = null;
  let token: string | null = null;
  
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    
    if (arg === "--host" && i + 1 < args.length) {
      host = args[i + 1];
      i++;
    } else if (arg.startsWith("--host=")) {
      host = arg.slice(7);
    } else if (arg === "--token" && i + 1 < args.length) {
      token = args[i + 1];
      i++;
    } else if (arg.startsWith("--token=")) {
      token = arg.slice(8);
    } else if (arg === "-h" || arg === "--help") {
      console.log(`
Clawflare CLI

Usage:
  pnpm cli [options]

Options:
  --host <url>    Harness URL (default: http://localhost:8787)
  --token <token> API token (or use CLAWFLARE_API_TOKEN env var)
  -h, --help      Show this help message

Examples:
  pnpm cli --host http://localhost:8787 --token xxx
  pnpm cli --host https://clawflare-harness.brendan-410.workers.dev
`);
      process.exit(0);
    }
  }
  
  // Fall back to environment variables
  if (!host) {
    host = process.env.CLAWFLARE_URL || "http://localhost:8787";
  }
  if (!token) {
    token = process.env.CLAWFLARE_API_TOKEN || "";
  }
  
  return { host, token };
}

function isDirectExecution(): boolean {
  const entrypoint = process.argv[1];
  return !!entrypoint && import.meta.url === pathToFileURL(entrypoint).href;
}

// Main entry point
if (isDirectExecution()) {
  const { host, token } = parseArgs();

  if (!token) {
    console.error("Error: CLAWFLARE_API_TOKEN required");
    console.error("Usage: --token <token> or CLAWFLARE_API_TOKEN env var");
    console.error("Run with -h for help");
    process.exit(1);
  }

  const client = new AgentClient(host, token);
  const app = createTUI(client);
  app.start();
}
