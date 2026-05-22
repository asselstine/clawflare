/**
 * Clawflare CLI - doctor command
 * Check project health
 */

import { execSync, spawn } from "child_process";
import * as fs from "fs/promises";
import * as path from "path";
import {
  loadConfigFromCwd,
  ConfigValidationError,
} from "../lib/load-project-config.js";

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
    passed: major >= 22,
    message: major >= 22 ? version : `${version} (requires >= 22)`,
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
    await loadConfigFromCwd();
    return {
      name: "clawflare.config.ts",
      passed: true,
      message: "Found and valid",
    };
  } catch (error) {
    if (error instanceof ConfigValidationError) {
      return {
        name: "clawflare.config.ts",
        passed: false,
        message: `Invalid: ${error.message}`,
      };
    }
    return {
      name: "clawflare.config.ts",
      passed: false,
      message: "Not found or not loadable",
    };
  }
}

async function checkRuntimePackage(): Promise<DoctorResult> {
  try {
    const pkgPath = path.join("node_modules", "@clawflare", "runtime", "package.json");
    await fs.access(pkgPath);
    return {
      name: "@clawflare/runtime installed",
      passed: true,
      message: "Found",
    };
  } catch {
    return {
      name: "@clawflare/runtime installed",
      passed: false,
      message: "Run npm install",
    };
  }
}

async function checkEnv(): Promise<DoctorResult> {
  let passed = false;
  let message = "No .env file";

  try {
    const envContent = await fs.readFile(".env", "utf-8");
    const hasToken =
      envContent.includes("CLAWFLARE_API_TOKEN=") || process.env.CLAWFLARE_API_TOKEN;
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

async function checkWranglerConfig(): Promise<DoctorResult> {
  const wranglerPath = path.join(".clawflare", "wrangler.jsonc");
  try {
    await fs.access(wranglerPath);
    return {
      name: "Wrangler config",
      passed: true,
      message: `Found ${wranglerPath}`,
    };
  } catch {
    return {
      name: "Wrangler config",
      passed: false,
      message: `Missing ${wranglerPath}. Run 'clawflare config generate'`,
    };
  }
}

async function checkMigrationsDir(): Promise<DoctorResult> {
  try {
    const entries = await fs.readdir("migrations");
    const hasMigrations = entries.some((e) => e.endsWith(".sql"));
    return {
      name: "Database migrations",
      passed: hasMigrations,
      message: hasMigrations ? `Found ${entries.length} migration(s)` : "No .sql files in migrations/",
    };
  } catch {
    return {
      name: "Database migrations",
      passed: false,
      message: "No migrations/ directory",
    };
  }
}

export async function doctorCommand(): Promise<void> {
  console.log("Running Clawflare diagnostics...\n");

  const checks = await Promise.all([
    checkNodeVersion(),
    checkPackageManager(),
    checkWrangler(),
    checkCloudflareAuth(),
    checkClawflareConfig(),
    checkRuntimePackage(),
    checkEnv(),
    checkWranglerConfig(),
    checkMigrationsDir(),
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
    console.log("\nSuggested fixes:");
    const failedChecks = checks.filter((c) => !c.passed);
    for (const check of failedChecks) {
      switch (check.name) {
        case "Node.js version":
          console.log("  - Install Node.js 22+ from https://nodejs.org");
          break;
        case "package.json exists":
          console.log("  - Run 'clawflare init <name>' to create a project");
          break;
        case "Wrangler CLI":
          console.log("  - Run 'npm install -g wrangler'");
          break;
        case "Cloudflare auth":
          console.log("  - Run 'wrangler login'");
          break;
        case "clawflare.config.ts":
          console.log("  - Check clawflare.config.ts for syntax errors");
          console.log("  - Make sure dependencies are installed (npm install)");
          break;
        case "@clawflare/runtime installed":
          console.log("  - Run 'npm install' in the project directory");
          break;
        case "Environment variables":
          console.log("  - Copy .env.example to .env and fill in values");
          break;
        case "Wrangler config":
          console.log("  - Run 'clawflare config generate'");
          break;
        case "Database migrations":
          console.log("  - Migrations will be created on first deploy");
          break;
      }
    }
    process.exit(1);
  }
}
