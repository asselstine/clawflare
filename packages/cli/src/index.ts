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
import {
  providersAddCommand,
  modelsListCommand,
  providersRemoveCommand,
  providersListCommand,
} from "./commands/providers.js";
import {
  egressAddCommand,
  egressDisableCommand,
  egressEnableCommand,
  egressListCommand,
  egressRemoveCommand,
} from "./commands/egress.js";

function formatCliError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message === "Invalid or missing authentication") {
    return "Invalid or missing authentication. Please run `clawflare login` first.";
  }
  return message;
}

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

// providers command
program
  .command("providers")
  .description("Manage AI model providers")
  .addCommand(
    new Command("add")
      .description("Add a new model provider")
      .option("-s, --server <url>", "Clawflare server URL", DEFAULT_SERVER)
      .option("-t, --token <token>", "API token for authentication")
      .action(async (options: { server?: string; token?: string }) => {
        await providersAddCommand(options);
      })
  )
  .addCommand(
    new Command("remove")
      .description("Remove a model provider")
      .argument("[name]", "Name or ID of the model connection to remove")
      .option("-s, --server <url>", "Clawflare server URL", DEFAULT_SERVER)
      .option("-t, --token <token>", "API token for authentication")
      .action(async (name: string | undefined, options: { server?: string; token?: string }) => {
        await providersRemoveCommand({ ...options, name });
      })
  )
  .addCommand(
    new Command("list")
      .description("List configured model providers")
      .option("-s, --server <url>", "Clawflare server URL", DEFAULT_SERVER)
      .option("-t, --token <token>", "API token for authentication")
      .option("--available", "List available providers from the server catalog")
      .action(async (options: { server?: string; token?: string; available?: boolean }) => {
        await providersListCommand(options);
      })
  );

// egress command
program
  .command("egress")
  .description("Manage egress handlers")
  .addCommand(
    new Command("add")
      .description("Add or configure an egress handler")
      .argument("[egressHandlerId]", "Egress handler ID")
      .option("-s, --server <url>", "Clawflare server URL", DEFAULT_SERVER)
      .option("-t, --token <token>", "API token for authentication")
      .action(async (egressHandlerId: string | undefined, options: { server?: string; token?: string }) => {
        await egressAddCommand({ ...options, egressHandlerId });
      })
  )
  .addCommand(
    new Command("list")
      .description("List egress handlers")
      .option("-s, --server <url>", "Clawflare server URL", DEFAULT_SERVER)
      .option("-t, --token <token>", "API token for authentication")
      .option("-a, --available", "List available egress handlers from the server catalog")
      .action(async (options: { server?: string; token?: string; available?: boolean }) => {
        await egressListCommand(options);
      })
  )
  .addCommand(
    new Command("enable")
      .description("Enable a configured egress handler")
      .argument("[egressHandlerId]", "Egress handler ID")
      .option("-s, --server <url>", "Clawflare server URL", DEFAULT_SERVER)
      .option("-t, --token <token>", "API token for authentication")
      .action(async (egressHandlerId: string | undefined, options: { server?: string; token?: string }) => {
        await egressEnableCommand({ ...options, egressHandlerId });
      })
  )
  .addCommand(
    new Command("disable")
      .description("Disable a configured egress handler")
      .argument("[egressHandlerId]", "Egress handler ID")
      .option("-s, --server <url>", "Clawflare server URL", DEFAULT_SERVER)
      .option("-t, --token <token>", "API token for authentication")
      .action(async (egressHandlerId: string | undefined, options: { server?: string; token?: string }) => {
        await egressDisableCommand({ ...options, egressHandlerId });
      })
  )
  .addCommand(
    new Command("remove")
      .alias("delete")
      .description("Delete a configured egress handler and its stored secrets")
      .argument("[egressHandlerId]", "Egress handler ID")
      .option("-s, --server <url>", "Clawflare server URL", DEFAULT_SERVER)
      .option("-t, --token <token>", "API token for authentication")
      .action(async (egressHandlerId: string | undefined, options: { server?: string; token?: string }) => {
        await egressRemoveCommand({ ...options, egressHandlerId });
      })
  );

// models command
program
  .command("models")
  .description("Manage configured model connections")
  .addCommand(
    new Command("list")
      .description("List configured model connections")
      .option("-s, --server <url>", "Clawflare server URL", DEFAULT_SERVER)
      .option("-t, --token <token>", "API token for authentication")
      .action(async (options: { server?: string; token?: string }) => {
        await modelsListCommand(options);
      })
  );

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
try {
  await program.parseAsync();
} catch (error) {
  console.error(`Error: ${formatCliError(error)}`);
  process.exit(1);
}
