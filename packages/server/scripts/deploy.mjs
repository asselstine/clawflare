#!/usr/bin/env node
/**
 * Deploy script.
 *
 * Deploys the Clawflare server via Wrangler.
 * Note: Model provider secrets are now configured per-workspace via the API,
 * not via Wrangler secrets. See README.md for details.
 */

import { spawn } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "../../..");

async function runCommand(command, args, { cwd = repoRoot, stdio } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      stdio: stdio ?? "inherit",
      cwd,
      env: process.env,
    });

    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
      } else {
        resolve();
      }
    });

    proc.on("error", reject);
  });
}

async function runWrangler(args, { stdio } = {}) {
  return runCommand("npx", ["wrangler", ...args], {
    cwd: join(__dirname, ".."),
    stdio,
  });
}

function parseArgs() {
  const args = process.argv.slice(2);
  const help = args.includes("-h") || args.includes("--help");
  return { help };
}

async function main() {
  const { help } = parseArgs();

  if (help) {
    console.log(`
Clawflare Deploy Script

Usage:
  node scripts/deploy.mjs [options]

Options:
  -h, --help       Show this help message

Note: Model provider secrets are now configured per-workspace via the API.
Users should run 'clawflare providers add' to configure providers.
`);
    process.exit(0);
  }

  console.log("🔨 Building deploy dependencies...\n");
  await runCommand("pnpm", ["--filter", "@clawflare/egress-core", "build"]);
  await runCommand("pnpm", ["--filter", "@clawflare/github", "build"]);
  await runCommand("pnpm", ["--filter", "@clawflare/cloudflare", "build"]);
  await runCommand("pnpm", ["--filter", "@clawflare/types", "build"]);
  await runCommand("pnpm", ["--filter", "@clawflare/server", "build"]);
  console.log("\n🚀 Deploying...\n");
  await runWrangler(["deploy"]);
  console.log("\n✅ Deployed successfully!");
}

main().catch((err) => {
  console.error("❌ Error:", err.message);
  process.exit(1);
});
