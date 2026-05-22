# Clawflare Quickstart

Get up and running with Clawflare in minutes.

## Prerequisites

- Node.js 22+
- pnpm 9+ (or npm/yarn)
- Cloudflare account with API token

## Install

```bash
npm install -g clawflare
```

## Create Your First Agent

```bash
# Create a new project
clawflare init my-agent
cd my-agent

# Install dependencies
npm install
```

## Deploy

```bash
# One-command deploy
clawflare deploy
```

The first deploy will:
- Create a D1 database
- Apply migrations
- Set up secrets
- Deploy your Worker
- Save deployment state

## Connect

```bash
# Open the TUI to chat with your agent
clawflare open
```

## Next Steps

- [CLI Reference](./cli.md) - All available commands
- [Configuration](./configuration.md) - Customize your agent
- [Custom Tools](./custom-tools.md) - Add your own tools
- [Custom Egress](./custom-egress.md) - Control outbound HTTP
