#!/usr/bin/env node
/**
 * Deploy script with KV namespace verification
 * 
 * Automatically creates KV namespaces if they don't exist,
 * then delegates to wrangler deploy.
 */

import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, "..", "wrangler.jsonc");

const KV_NAMESPACES = [
  { binding: "AGENT_SESSION", placeholder: "local-agent-state-namespace-id" },
];

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

async function listKvNamespaces() {
  try {
    const output = await runWrangler(["kv", "namespace", "list"], { capture: true });
    return JSON.parse(output);
  } catch {
    return [];
  }
}

async function listSecrets() {
  try {
    const output = await runWrangler(["secret", "list"], { capture: true });
    return JSON.parse(output);
  } catch {
    return [];
  }
}

async function createKvNamespace(binding) {
  console.log(`📝 Creating KV namespace: ${binding}`);
  const output = await runWrangler(["kv", "namespace", "create", binding], { capture: true });
  
  // Parse the ID from output (format: { "binding": "X", "id": "Y" })
  let id;
  try {
    const parsed = JSON.parse(output);
    id = parsed.id;
  } catch {
    // Try to extract ID from the output using regex
    const idMatch = output.match(/"id":\s*"([^"]+)"/);
    if (idMatch) {
      id = idMatch[1];
    }
  }

  if (!id) {
    throw new Error(`Could not extract namespace ID from output: ${output}`);
  }

  console.log(`  Created with ID: ${id}`);
  return id;
}

async function updateConfigFile(binding, id, placeholder) {
  const config = await readFile(CONFIG_PATH, "utf-8");
  
  // Simple string replacement for the specific binding's placeholder
  // Match pattern: "binding": "BINDING", followed by any whitespace, then "id": "PLACEHOLDER"
  const pattern = new RegExp(
    `("binding":\\s*"${binding}"\\s*,\\s*\\n\\s*"id":\\s*")${placeholder}(")`,
    "g"
  );
  
  const updatedConfig = config.replace(pattern, `$1${id}$2`);
  
  if (updatedConfig === config) {
    console.log(`  ⚠️ Could not find placeholder for ${binding} in config`);
    return false;
  }
  
  await writeFile(CONFIG_PATH, updatedConfig, "utf-8");
  console.log(`  Updated wrangler.jsonc`);
  return true;
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
  1. Check/create KV namespaces if needed
  2. Set secrets from .dev.vars (skips if already set, unless --force-secrets)
  3. Run wrangler deploy
`);
    process.exit(0);
  }

  // Read current config to check for placeholders
  const config = await readFile(CONFIG_PATH, "utf-8");
  const placeholdersFound = KV_NAMESPACES.filter(
    ({ placeholder }) => config.includes(placeholder)
  );

  if (placeholdersFound.length > 0) {
    console.log("🔍 Found placeholder KV namespace IDs. Checking/creating namespaces...\n");
    
    const existingNamespaces = await listKvNamespaces();
    
    for (const { binding, placeholder } of placeholdersFound) {
      const existing = existingNamespaces.find(
        (ns) => ns.binding === binding || ns.title?.includes(binding)
      );
      
      if (existing) {
        console.log(`✅ KV namespace ${binding} already exists: ${existing.id}`);
        await updateConfigFile(binding, existing.id, placeholder);
      } else {
        const id = await createKvNamespace(binding);
        await updateConfigFile(binding, id, placeholder);
      }
    }
    
    console.log();
  }

  // Get existing secrets
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

  // Now run wrangler deploy
  console.log("🚀 Deploying...\n");
  await runWrangler(["deploy"]);
  console.log("\n✅ Deployed successfully!");
}

main().catch((err) => {
  console.error("❌ Error:", err.message);
  process.exit(1);
});
