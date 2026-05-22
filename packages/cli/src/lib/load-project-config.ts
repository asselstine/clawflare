/**
 * Load and validate Clawflare project configuration
 * Uses tsx to import TypeScript config files
 */

import { execSync } from "child_process";
import * as fs from "fs/promises";
import * as path from "path";
import { fileURLToPath } from "url";

export interface AiConfig {
  provider?: string;
  model?: string;
}

export interface CloudflareConfig {
  compatibilityDate?: string;
  workerName?: string;
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
    await fs.access(configPath);
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
    await fs.access(configPath);
  } catch {
    throw new ConfigValidationError(
      `No clawflare.config.ts found in ${projectDir}\n` +
        "Run 'clawflare init <name>' to create a new project"
    );
  }

  try {
    // Use tsx to import the TypeScript config
    // This imports the config and gets the default export
    const tsxPath = path.join(projectDir, "node_modules", ".bin", "tsx");
    const tsxCmd = `"${tsxPath}" --import "${configPath}" -e "console.log(JSON.stringify(require('${configPath.replace(/\\/g, "/")}').default || require('${configPath.replace(/\\/g, "/")}')))"`;

    // Fallback: try running tsx directly if available
    let configJson: string;
    try {
      configJson = execSync(
        `npx tsx --eval "import config from '${configPath.replace(/\\/g, "/")}'; console.log(JSON.stringify(config));"`,
        {
          cwd: projectDir,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
          env: { ...process.env, FORCE_COLOR: "0" },
        }
      );
    } catch {
      // Try alternative method: read and evaluate with ts-node or direct tsx
      const result = execSync(
        `node --import tsx -e "import config from '${configPath.replace(/\\/g, "/")}'; console.log(JSON.stringify(config));"`,
        {
          cwd: projectDir,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
          env: { ...process.env, FORCE_COLOR: "0" },
        }
      );
      configJson = result;
    }

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
        "2. You've run 'npm install' or equivalent\n" +
        "3. Your clawflare.config.ts has a default export\n" +
        '4. Example: export default defineClawflareConfig({ name: "my-agent" })'
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
  const baseName = config.cloudflare?.workerName || config.name;
  return env ? `${baseName}-${env}` : baseName;
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
