#!/usr/bin/env node
/**
 * Clawflare CLI
 * A terminal UI interface for the Clawflare agent harness.
 */

import { Command } from "commander";
import { loginCommand, logoutCommand, whoamiCommand } from "./commands/login.js";
import { openCommand } from "./commands/open.js";

const program = new Command()
  .name("clawflare")
  .description("Clawflare CLI - Client for the Clawflare hosted agent harness")
  .version("0.1.0");

// login command
program
  .command("login")
  .description("Authenticate with the Clawflare server")
  .option("-s, --server <url>", "Clawflare server URL", "https://app.clawflare.dev")
  .action(async (options: { server?: string }) => {
    await loginCommand({ server: options.server });
  });

// logout command
program
  .command("logout")
  .description("Remove stored authentication")
  .action(async () => {
    await logoutCommand();
  });

// whoami command
program
  .command("whoami")
  .description("Show current authentication status")
  .action(async () => {
    await whoamiCommand();
  });

// open command
program
  .command("open")
  .description("Open the TUI for your agent")
  .option("-s, --server <url>", "Clawflare server URL")
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

// Parse arguments
program.parse();
