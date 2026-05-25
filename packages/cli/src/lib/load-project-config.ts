/**
 * Load and validate Clawflare project configuration
 * Uses tsx to import TypeScript config files
 */

import { execSync } from "child_process";
import * as fs from "fs";
import * as fsPromises from "fs/promises";
import * as path from "path";
import { fileURLToPath } from "url";
import * as Module from "module";
import { getConfigRuntimeNames } from "@clawflare/runtime/runtime-names";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Resolve the path to the tsx binary.
 * First tries to resolve from the CLI's dependencies, then falls back to global resolution.
 */
function resolveTsxPath(): string {
  // First, try to resolve tsx from the CLI's own node_modules
  const cliNodeModules = path.resolve(__dirname, "..", "..");
  const cliTsxPath = path.join(cliNodeModules, "node_modules", ".bin", "tsx");
  
  try {
    // Check if tsx exists at the CLI's location (sync version)
    fs.accessSync(cliTsxPath);
    return cliTsxPath;
  } catch {
    // Fallback: try to resolve tsx using Node's module resolution
    try {
      const require = Module.createRequire(import.meta.url);
      const tsxMain = require.resolve("tsx");
      // tsx main is at dist/loader.mjs or similar, bin is at dist/cli.mjs
      const tsxDir = path.dirname(tsxMain);
      return path.join(tsxDir, "cli.mjs");
    } catch {
      // Last resort: assume tsx is in PATH
      return "tsx";
    }
  }
}

const tsxPath = resolveTsxPath();

export interface AiConfig {
  provider?: string;
  model?: string;
}

export interface CloudflareConfig {
  compatibilityDate?: string;
  workerName?: string;
  workflowName?: string;
}

export interface SecretSpec {
  name: string;
  required?: boolean;
  description?: string;
}

export interface ClawflareConfig {
  name: string;
  ai?: AiConfig;
  cloudflare?: CloudflareConfig;
  secrets?: SecretSpec[];
  // Tool factories and egress handlers are not serializable
  // but defined in config for runtime
  tools?: unknown;
  egressHandlers?: unknown;
  plugins?: unknown;
}

export interface LoadedConfig {
  config: ClawflareConfig;
  configPath: string;
  projectDir: string;
}

export class ConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigValidationError";
  }
}

/**
 * Check if a Clawflare project exists in the given directory
 */
export async function isClawflareProject(projectDir: string): Promise<boolean> {
  try {
    const configPath = path.join(projectDir, "clawflare.config.ts");
    await fsPromises.access(configPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Load the Clawflare configuration from a project directory
 * Uses tsx to transpile and execute the TypeScript config file
 */
export async function loadProjectConfig(projectDir: string): Promise<LoadedConfig> {
  const configPath = path.join(projectDir, "clawflare.config.ts");

  // Check if config file exists
  try {
    await fsPromises.access(configPath);
  } catch {
    throw new ConfigValidationError(
      `No clawflare.config.ts found in ${projectDir}\n` +
        "Run 'clawflare init <name>' to create a new project"
    );
  }

  // Check if node_modules exists (dependencies installed)
  const nodeModulesPath = path.join(projectDir, "node_modules");
  try {
    await fsPromises.access(nodeModulesPath);
  } catch {
    throw new ConfigValidationError(
      `Dependencies not installed in ${projectDir}\n` +
        "Run 'npm install' or equivalent to install dependencies"
    );
  }

  try {
    // Use tsx from the CLI's own node_modules to import the TypeScript config
    const importPath = configPath.replace(/\\/g, "/");
    const configJson = execSync(
      `"${tsxPath}" --eval "import config from '${importPath}'; console.log(JSON.stringify(config));"`,
      {
        cwd: projectDir,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, FORCE_COLOR: "0" },
      }
    );

    const config = JSON.parse(configJson.trim()) as ClawflareConfig;

    // Validate the loaded config
    validateConfig(config);

    return {
      config,
      configPath,
      projectDir,
    };
  } catch (error) {
    if (error instanceof ConfigValidationError) {
      throw error;
    }

    // Provide helpful error message for import failures
    throw new ConfigValidationError(
      `Failed to load clawflare.config.ts:\n` +
        (error instanceof Error ? error.message : String(error)) +
        "\n\nMake sure:\n" +
        "1. You're in a Clawflare project directory\n" +
        "2. Your clawflare.config.ts has a default export\n" +
        '3. Example: export default defineClawflareConfig({ name: "my-agent" })'
    );
  }
}

/**
 * Validate the loaded configuration
 */
export function validateConfig(config: unknown): asserts config is ClawflareConfig {
  if (!config || typeof config !== "object") {
    throw new ConfigValidationError("Config must be an object");
  }

  const c = config as Record<string, unknown>;

  // name is required
  if (!c.name || typeof c.name !== "string") {
    throw new ConfigValidationError("Config must have a 'name' property of type string");
  }

  // ai is optional
  if (c.ai !== undefined) {
    if (typeof c.ai !== "object" || c.ai === null) {
      throw new ConfigValidationError("Config 'ai' must be an object");
    }
    const ai = c.ai as Record<string, unknown>;
    if (ai.provider !== undefined && typeof ai.provider !== "string") {
      throw new ConfigValidationError("Config 'ai.provider' must be a string");
    }
    if (ai.model !== undefined && typeof ai.model !== "string") {
      throw new ConfigValidationError("Config 'ai.model' must be a string");
    }
  }

  // cloudflare is optional
  if (c.cloudflare !== undefined) {
    if (typeof c.cloudflare !== "object" || c.cloudflare === null) {
      throw new ConfigValidationError("Config 'cloudflare' must be an object");
    }
    const cf = c.cloudflare as Record<string, unknown>;
    if (cf.compatibilityDate !== undefined && typeof cf.compatibilityDate !== "string") {
      throw new ConfigValidationError("Config 'cloudflare.compatibilityDate' must be a string");
    }
    if (cf.workerName !== undefined && typeof cf.workerName !== "string") {
      throw new ConfigValidationError("Config 'cloudflare.workerName' must be a string");
    }
    if (cf.workflowName !== undefined && typeof cf.workflowName !== "string") {
      throw new ConfigValidationError("Config 'cloudflare.workflowName' must be a string");
    }
  }

  // secrets is optional array
  if (c.secrets !== undefined) {
    if (!Array.isArray(c.secrets)) {
      throw new ConfigValidationError("Config 'secrets' must be an array");
    }
    for (let i = 0; i < c.secrets.length; i++) {
      const secret = c.secrets[i];
      if (!secret || typeof secret !== "object") {
        throw new ConfigValidationError(`Config 'secrets[${i}]' must be an object`);
      }
      const s = secret as Record<string, unknown>;
      if (typeof s.name !== "string") {
        throw new ConfigValidationError(`Config 'secrets[${i}].name' must be a string`);
      }
    }
  }
}

/**
 * Load config from current working directory
 */
export async function loadConfigFromCwd(): Promise<LoadedConfig> {
  return loadProjectConfig(process.cwd());
}

/**
 * Get the effective worker name from config or project name
 */
export function getWorkerName(config: ClawflareConfig, env?: string): string {
  return getConfigRuntimeNames(config, env).workerName;
}

/**
 * Get the effective workflow name from config or project name
 */
export function getWorkflowName(config: ClawflareConfig, env?: string): string {
  return getConfigRuntimeNames(config, env).workflowName;
}

/**
 * Get the effective database name from config or project name
 */
export function getDatabaseName(config: ClawflareConfig, env?: string): string {
  return env ? `${config.name}-${env}` : config.name;
}

/**
 * Get the compatibility date from config or default
 */
export function getCompatibilityDate(config: ClawflareConfig): string {
  return config.cloudflare?.compatibilityDate || "2025-01-01";
}

/**
 * Merge secrets from config with built-in secrets
 */
export function getAllSecrets(config: ClawflareConfig): SecretSpec[] {
  const builtins: SecretSpec[] = [
    { name: "CLAWFLARE_API_TOKEN", required: true, description: "API token for Clawflare authentication" },
    { name: "AWS_BEARER_TOKEN_BEDROCK", required: false, description: "AWS bearer token for Bedrock AI" },
    { name: "ANTHROPIC_API_KEY", required: false, description: "Anthropic API key for Claude" },
    { name: "OPENAI_API_KEY", required: false, description: "OpenAI API key" },
  ];

  const configSecrets = config.secrets || [];
  const configSecretNames = new Set(configSecrets.map((s) => s.name));

  // Add builtin secrets that aren't already in config
  for (const builtin of builtins) {
    if (!configSecretNames.has(builtin.name)) {
      configSecrets.push(builtin);
    }
  }

  return configSecrets;
}
