# Clawflare

<!-- Edited by agent -->

[![npm version](https://img.shields.io/npm/v/clawflare.svg)](https://www.npmjs.com/package/clawflare)

An agent harness that runs on Cloudflare infrastructure.

## Quickstart (Hosted)

```bash
# Install CLI globally
npm install -g clawflare

# Login to the hosted service
clawflare login

# Open the TUI
clawflare open
```

## What is Clawflare?

Clawflare is an AI agent harness that runs as a hosted service on Cloudflare Workers. It provides:

- **Durable Sessions**: Multi-turn conversations with persistent context
- **Tool Execution**: JavaScript execution, container workspaces, file operations
- **Workspace Scoping**: Multi-tenant data isolation
- **WebSocket Support**: Real-time TUI interface
- **Cloud-Native**: Built on Cloudflare D1, Durable Objects, and Workflows

## Architecture

```
┌─────────────┐     ┌─────────────────────────────────────────────┐
│   CLI/TUI   │────▶│           Clawflare Server                  │
│  (clawflare) │     │  ┌─────────┐  ┌─────────┐  ┌─────────────┐ │
└─────────────┘     │  │   API   │  │Workflows│  │   Durable   │ │
      │             │  │ Routes  │  │(Session)│  │   Objects   │ │
      │             │  └────┬────┘  └────┬────┘  └─────────────┘ │
      │             │       │            │                        │
      │             │  ┌────▼────────────▼─────────────────────┐ │
      │ WebSocket  │  │              D1 Database                │ │
      └─────────────│  │  (sessions, events, stored code, etc)  │ │
                    │  └─────────────────────────────────────────┘ │
                    └─────────────────────────────────────────────┘
```

## Package Layout

```
packages/
  server/          # Cloudflare Worker server implementation
  cli/             # API client + TUI launcher (published as "clawflare")
  egress-core/     # Shared egress abstractions
  github/          # GitHub API egress handler
  cloudflare/      # Cloudflare API egress handler
  e2e/             # End-to-end tests
```

## Self-Hosting

To run your own Clawflare server:

```bash
# Clone the repository
git clone https://github.com/asselstine/clawflare
cd clawflare

# Install dependencies
pnpm install

# Set up environment
cp packages/server/.env.example packages/server/.env
# Edit .env with your credentials

# Run local dev server
pnpm dev

# Apply database migrations (local)
pnpm --filter @clawflare/server db:migrations:apply:local

# Or apply migrations to remote D1
pnpm --filter @clawflare/server db:migrations:apply:remote

# Deploy to Cloudflare
pnpm deploy
```

## CLI Commands

```
clawflare login          # Authenticate with Clawflare server
clawflare logout         # Remove stored authentication
clawflare whoami         # Show current authentication status
clawflare open           # Open the TUI

Options:
  --server <url>         # Connect to self-hosted server
  --token <token>        # Use specific API token
  --workspace <id>       # Use specific workspace
```

## Development

```bash
# Build all packages
pnpm build

# Type check
pnpm typecheck

# Run unit tests
pnpm --filter @clawflare/server test

# Run E2E tests
pnpm test:e2e
```

## Documentation

- [Quickstart](./docs/quickstart.md) - Get started with Clawflare
- [CLI Reference](./docs/cli.md) - Command-line interface
- [Self-Hosting](./docs/self-hosting.md) - Running your own server
- [Architecture](./docs/architecture.md) - System design and de-packaging decision
- [AI Providers](./docs/ai-providers.md) - Configuring AI providers
- [Troubleshooting](./docs/troubleshooting.md) - Common issues

## License
