/**
 * Clawflare CLI - dev command
 * Start local development server
 */

import { spawn } from "child_process";
import * as path from "path";

interface DevOptions {
  port?: number;
  local?: boolean;
}

export async function devCommand(options: DevOptions): Promise<void> {
  const cwd = process.cwd();
  const wranglerPath = path.join(cwd, ".clawflare", "wrangler.jsonc");

  console.log("Starting Clawflare development server...\n");

  // Build args for wrangler dev
  const args = ["dev", "--config", wranglerPath];
  
  if (options.port) {
    args.push("--port", options.port.toString());
  }

  if (options.local) {
    args.push("--local");
  }

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
