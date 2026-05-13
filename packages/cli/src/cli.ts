/**
 * CLI Framework
 *
 * Simple CLI framework for Clawflare.
 */

import process from 'node:process';

export interface Command {
  name: string;
  description: string;
  options?: Option[];
  action: (options: Record<string, unknown>, args: string[]) => Promise<void>;
}

export interface Option {
  name: string;
  alias?: string;
  description: string;
  type: 'string' | 'boolean' | 'number';
  default?: unknown;
  required?: boolean;
}

export interface CliOptions {
  name: string;
  version: string;
  description: string;
  commands: Command[];
}

export class Cli {
  private name: string;
  private version: string;
  private description: string;
  private commands: Command[];

  constructor(options: CliOptions) {
    this.name = options.name;
    this.version = options.version;
    this.description = options.description;
    this.commands = options.commands;
  }

  private printHelp(): void {
    console.log(`
${this.name} v${this.version}

${this.description}

Usage:
  ${this.name} <command> [options]

Commands:
${this.commands.map(cmd => `  ${cmd.name.padEnd(12)} ${cmd.description}`).join('\n')}

Options:
  -h, --help     Show this help message
  -v, --version  Show version number
`);
  }

  private findCommand(name: string): Command | undefined {
    return this.commands.find(cmd => cmd.name === name);
  }

  private parseOptions(args: string[]): {
    options: Record<string, unknown>;
    commandArgs: string[];
    commandName: string | null;
  } {
    const options: Record<string, unknown> = {};
    let commandName: string | null = null;
    const commandArgs: string[] = [];

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];

      // Help and version
      if (arg === '-h' || arg === '--help') {
        options.help = true;
        continue;
      }
      if (arg === '-v' || arg === '--version') {
        options.version = true;
        continue;
      }

      // Commands
      if (!arg.startsWith('-') && !commandName) {
        commandName = arg;
        continue;
      }

      // Options
      if (arg.startsWith('-')) {
        const isLong = arg.startsWith('--');
        const name = isLong ? arg.slice(2) : arg.slice(1);

        // Look for = in --option=value
        let value: string | boolean = true;
        if (name.includes('=')) {
          const [optName, optValue] = name.split('=');
          options[optName] = optValue;
        } else {
          // Check if next arg is a value
          const nextArg = args[i + 1];
          if (nextArg && !nextArg.startsWith('-')) {
            options[name] = nextArg;
            i++;
          } else {
            options[name] = true;
          }
        }
        continue;
      }

      // Remaining args go to command
      commandArgs.push(arg);
    }

    return { options, commandArgs, commandName };
  }

  async run(): Promise<void> {
    const args = process.argv.slice(2);

    // No args = help
    if (args.length === 0) {
      this.printHelp();
      process.exit(0);
    }

    const { options, commandArgs, commandName } = this.parseOptions(args);

    // Handle global options
    if (options.help) {
      this.printHelp();
      process.exit(0);
    }

    if (options.version) {
      console.log(`${this.name} v${this.version}`);
      process.exit(0);
    }

    // Find command
    if (!commandName) {
      console.error(`Error: No command specified. Run '${this.name} --help' for usage.`);
      process.exit(1);
    }

    const command = this.findCommand(commandName);
    if (!command) {
      console.error(`Error: Unknown command '${commandName}'. Run '${this.name} --help' for available commands.`);
      process.exit(1);
    }

    // Check required options
    if (command.options) {
      for (const opt of command.options) {
        if (opt.required && !(opt.name in options)) {
          console.error(`Error: Required option '--${opt.name}' is missing.`);
          process.exit(1);
        }
        // Apply defaults
        if (!(opt.name in options) && opt.default !== undefined) {
          options[opt.name] = opt.default;
        }
      }
    }

    // Run command
    try {
      await command.action(options, commandArgs);
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  }
}