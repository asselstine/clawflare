#!/usr/bin/env node
/**
 * Clawflare CLI
 * A terminal UI interface for the Clawflare agent harness.
 */

import { Command } from "commander";
import { config } from "dotenv";
import {
  initCommand,
  deployCommand,
  openCommand,
  devCommand,
  doctorCommand,
  statusCommand,
} from "./commands/index.js";

// Load .env file from current directory
config({ path: ".env" });

const program = new Command()
  .name("clawflare")
  .description("Clawflare CLI - AI agent harness for Cloudflare Workers")
  .version("0.1.0");

// init command
program
  .command("init <name>")
  .description("Create a new Clawflare project")
  .option("-t, --template <template>", "Template to use (minimal, github, cloudflare, full)", "minimal")
  .option("-p, --package-manager <pm>", "Package manager (npm, pnpm, yarn)")
  .option("--no-install", "Skip dependency installation")
  .option("--provider <provider>", "AI provider (amazon-bedrock, anthropic, openai)", "amazon-bedrock")
  .option("--model <model>", "AI model")
  .action(async (name: string, options: {
    template: string;
    packageManager?: string;
    install: boolean;
    provider: string;
    model?: string;
  }) => {
    await initCommand(name, {
      template: options.template,
      packageManager: options.packageManager as "npm" | "pnpm" | "yarn" | undefined,
      noInstall: !options.install,
      provider: options.provider,
      model: options.model,
    });
  });

// deploy command
program
  .command("deploy")
  .description("Deploy the project to Cloudflare")
  .option("-e, --env <environment>", "Environment (production, staging)")
  .option("--print-config", "Print generated Wrangler config without deploying")
  .option("-f, --force", "Force recreation of resources")
  .action(async (options: {
    env?: string;
    printConfig: boolean;
    force: boolean;
  }) => {
    await deployCommand({
      env: options.env,
      printConfig: options.printConfig,
      force: options.force,
    });
  });

// open command
program
  .command("open")
  .description("Open the TUI for your agent")
  .option("--host <url>", "Harness URL (overrides state)")
  .option("--token <token>", "API token (overrides env)")
  .option("--local", "Connect to local development server")
  .action(async (options: {
    host?: string;
    token?: string;
    local: boolean;
  }) => {
    await openCommand({
      host: options.host,
      token: options.token,
      local: options.local,
    });
  });

// dev command
program
  .command("dev")
  .description("Start local development server")
  .option("-p, --port <port>", "Port to run on", parseInt)
  .option("--local", "Use local mode")
  .action(async (options: {
    port?: number;
    local: boolean;
  }) => {
    await devCommand({
      port: options.port,
      local: options.local,
    });
  });

// doctor command
program
  .command("doctor")
  .description("Check project health and configuration")
  .action(async () => {
    await doctorCommand();
  });

// status command
program
  .command("status")
  .description("Show deployment status")
  .action(async () => {
    await statusCommand();
  });

// Parse arguments
program.parse();
