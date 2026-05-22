/**
 * Clawflare CLI - doctor command
 * Check project health
 */

import { execSync } from "child_process";
import * as fs from "fs/promises";
import * as path from "path";

interface DoctorResult {
  name: string;
  passed: boolean;
  message: string;
}

async function checkNodeVersion(): Promise<DoctorResult> {
  const version = process.version;
  const major = parseInt(version.slice(1).split(".")[0]);
  return {
    name: "Node.js version",
    passed: major >= 18,
    message: major >= 18 ? version : `${version} (requires >= 18)`,
  };
}

async function checkPackageManager(): Promise<DoctorResult> {
  try {
    await fs.access("package.json");
    return {
      name: "package.json exists",
      passed: true,
      message: "Found package.json",
    };
  } catch {
    return {
      name: "package.json exists",
      passed: false,
      message: "No package.json found",
    };
  }
}

async function checkWrangler(): Promise<DoctorResult> {
  try {
    const version = execSync("wrangler --version", { encoding: "utf-8" }).trim();
    return {
      name: "Wrangler CLI",
      passed: true,
      message: version,
    };
  } catch {
    return {
      name: "Wrangler CLI",
      passed: false,
      message: "wrangler not found (npm install -g wrangler)",
    };
  }
}

async function checkCloudflareAuth(): Promise<DoctorResult> {
  try {
    execSync("wrangler whoami", { stdio: "pipe" });
    return {
      name: "Cloudflare auth",
      passed: true,
      message: "Authenticated",
    };
  } catch {
    return {
      name: "Cloudflare auth",
      passed: false,
      message: "Not authenticated (wrangler login)",
    };
  }
}

async function checkClawflareConfig(): Promise<DoctorResult> {
  try {
    await fs.access("clawflare.config.ts");
    return {
      name: "clawflare.config.ts",
      passed: true,
      message: "Found",
    };
  } catch {
    return {
      name: "clawflare.config.ts",
      passed: false,
      message: "Not found",
    };
  }
}

async function checkDependencies(): Promise<DoctorResult> {
  try {
    const nodeModules = await fs.readdir("node_modules");
    const hasClawflare = nodeModules.includes("@clawflare");
    return {
      name: "Dependencies installed",
      passed: hasClawflare,
      message: hasClawflare ? "Found @clawflare packages" : "Run npm install",
    };
  } catch {
    return {
      name: "Dependencies installed",
      passed: false,
      message: "No node_modules found",
    };
  }
}

async function checkEnv(): Promise<DoctorResult> {
  let passed = false;
  let message = "No .env file";
  
  try {
    const envContent = await fs.readFile(".env", "utf-8");
    const hasToken = envContent.includes("CLAWFLARE_API_TOKEN=") || 
                     process.env.CLAWFLARE_API_TOKEN;
    passed = !!hasToken;
    message = hasToken ? "CLAWFLARE_API_TOKEN found" : "Missing CLAWFLARE_API_TOKEN";
  } catch {
    // .env doesn't exist
  }

  if (!passed && process.env.CLAWFLARE_API_TOKEN) {
    passed = true;
    message = "CLAWFLARE_API_TOKEN in environment";
  }

  return {
    name: "Environment variables",
    passed,
    message,
  };
}

export async function doctorCommand(): Promise<void> {
  console.log("Running Clawflare diagnostics...\n");

  const checks = await Promise.all([
    checkNodeVersion(),
    checkPackageManager(),
    checkWrangler(),
    checkCloudflareAuth(),
    checkClawflareConfig(),
    checkDependencies(),
    checkEnv(),
  ]);

  let passed = 0;
  let failed = 0;

  for (const check of checks) {
    const icon = check.passed ? "✓" : "✗";
    const color = check.passed ? "\x1b[32m" : "\x1b[31m";
    const reset = "\x1b[0m";
    console.log(`${color}${icon}${reset} ${check.name}: ${check.message}`);
    
    if (check.passed) {
      passed++;
    } else {
      failed++;
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);

  if (failed > 0) {
    process.exit(1);
  }
}
