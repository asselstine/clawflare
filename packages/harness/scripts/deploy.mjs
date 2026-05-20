#!/usr/bin/env node
/**
 * Deploy script.
 *
 * Sets required secrets from .dev.vars when needed, then delegates to wrangler deploy.
 */

import { spawn } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SECRETS = ["AWS_BEARER_TOKEN_BEDROCK", "CLOUDFLARE_API_TOKEN", "CLAWFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"];

async function runWrangler(args, { capture = false, stdio = undefined } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn("npx", ["wrangler", ...args], {
      stdio: stdio ?? (capture ? "pipe" : "inherit"),
      cwd: join(__dirname, ".."),
    });

    let stdout = "";
    if (capture) {
      proc.stdout.on("data", (data) => {
        stdout += data.toString();
      });
    }

    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`wrangler ${args.join(" ")} exited with code ${code}`));
      } else {
        resolve(capture ? stdout : undefined);
      }
    });

    proc.on("error", reject);
  });
}

async function listSecrets() {
  try {
    const output = await runWrangler(["secret", "list"], { capture: true });
    return JSON.parse(output);
  } catch {
    return [];
  }
}

function parseArgs() {
  const args = process.argv.slice(2);
  const forceSecrets = args.includes("--force-secrets");
  const help = args.includes("-h") || args.includes("--help");
  return { forceSecrets, help };
}

async function main() {
  const { forceSecrets, help } = parseArgs();
  
  if (help) {
    console.log(`
Clawflare Deploy Script

Usage:
  node scripts/deploy.mjs [options]

Options:
  --force-secrets  Force update all secrets even if already set
  -h, --help       Show this help message

The script will:
  1. Set secrets from .dev.vars (skips if already set, unless --force-secrets)
  2. Run wrangler deploy
`);
    process.exit(0);
  }

  console.log("🔐 Checking secrets...\n");
  const existingSecrets = await listSecrets();
  const existingSecretNames = new Set(existingSecrets.map(s => s.name));
  
  for (const secret of SECRETS) {
    if (!forceSecrets && existingSecretNames.has(secret)) {
      console.log(`  ⏭️  ${secret} already set, skipping (use --force-secrets to update)`);
      continue;
    }
    
    console.log(`  ${forceSecrets && existingSecretNames.has(secret) ? "🔄 Updating" : "📝 Setting"} ${secret}...`);
    await runWrangler(["secret", "put", secret, "--env-file", ".dev.vars"]);
  }
  
  console.log();
  console.log("🚀 Deploying...\n");
  await runWrangler(["deploy"]);
  console.log("\n✅ Deployed successfully!");
}

main().catch((err) => {
  console.error("❌ Error:", err.message);
  process.exit(1);
});
