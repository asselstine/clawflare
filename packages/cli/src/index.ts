#!/usr/bin/env node
/**
 * Clawflare CLI
 * A terminal UI interface for the Clawflare agent harness.
 */

import { Command } from "commander";
import { DEFAULT_SERVER } from "./constants.js";
import { loginCommand, logoutCommand, whoamiCommand } from "./commands/login.js";
import { openCommand } from "./commands/open.js";
import { doctorCommand } from "./commands/doctor.js";

const program = new Command()
  .name("clawflare")
  .description("Clawflare CLI - Client for the Clawflare hosted agent harness")
  .version("0.1.0");

// login command
program
  .command("login")
  .description("Authenticate with the Clawflare server using GitHub OAuth")
  .option("-s, --server <url>", "Clawflare server URL", DEFAULT_SERVER)
  .option("--provider <provider>", "Authentication provider", "github")
  .option("--no-open", "Do not open a browser automatically")
  .option("--timeout <seconds>", "Login timeout in seconds", "600")
  .action(async (options: { 
    server?: string; 
    provider?: string;
    open?: boolean;
    timeout?: string;
  }) => {
    await loginCommand({ 
      server: options.server,
      provider: options.provider as "github",
      open: options.open,
      timeout: Number(options.timeout),
    });
  });

// logout command
program
  .command("logout")
  .description("Remove stored authentication")
  .option("--all", "Delete entire configuration (including server URL)")
  .option("-s, --server <url>", "Clawflare server URL (for revocation)", DEFAULT_SERVER)
  .action(async (options: { all?: boolean; server?: string }) => {
    await logoutCommand({
      all: options.all,
      server: options.server,
    });
  });

// whoami command
program
  .command("whoami")
  .description("Show current authentication status")
  .option("-s, --server <url>", "Clawflare server URL", DEFAULT_SERVER)
  .action(async (options: {
    server?: string;
  }) => {
    await whoamiCommand({
      server: options.server,
    });
  });

// open command
program
  .command("open")
  .description("Open the TUI for your agent")
  .option("-s, --server <url>", "Clawflare server URL", DEFAULT_SERVER)
  .option("-t, --token <token>", "API token for authentication")
  .option("-w, --workspace <workspace>", "Workspace to use")
  .action(async (options: {
    server?: string;
    token?: string;
    workspace?: string;
  }) => {
    await openCommand({
      server: options.server,
      token: options.token,
      workspace: options.workspace,
    });
  });

// doctor command
program
  .command("doctor")
  .description("Diagnose authentication and connection issues")
  .option("-s, --server <url>", "Clawflare server URL", DEFAULT_SERVER)
  .action(async (options: {
    server?: string;
  }) => {
    await doctorCommand({
      server: options.server,
    });
  });

// Parse arguments
program.parse();
