# Clawflare

[![npm version](https://img.shields.io/npm/v/clawflare.svg)](https://www.npmjs.com/package/clawflare)

An agent harness that runs directly on Cloudflare infrastructure as a worker.

## Quickstart

```bash
# Install CLI globally
npm install -g clawflare

# Create new agent
clawflare init my-agent
cd my-agent

# Deploy
clawflare deploy

# Open TUI
clawflare open
```

## Global Installation

```bash
npm install -g clawflare
pnpm add -g clawflare
yarn global add clawflare
```

Or use without installing:
```bash
npx clawflare init my-agent
```

## Usage

### Prerequisites

- Node.js 22+
- Cloudflare account with API token that can manage Workers and D1
- AI provider API key (Anthropic, OpenAI, or AWS Bedrock)

### Cloudflare API Token Permissions

Create a token with these permissions:

| Scope | Permission |
|-------|------------|
| Account | Workers Scripts:Edit |
| Account | D1:Edit |
| Account | Account Settings:Read |

### Commands

All lifecycle commands are handled by the CLI:

```bash
# Initialize new project
clawflare init my-agent

# Deploy to Cloudflare
clawflare deploy

# Open TUI
clawflare open

# Run local dev server
clawflare dev

# Check status
clawflare status

# Diagnose issues
clawflare doctor

# Set secrets
clawflare secret set ANTHROPIC_API_KEY
```

## Project Configuration

Edit `clawflare.config.ts`:

```typescript
import { defineClawflareConfig } from "@clawflare/runtime";
import { github } from "@clawflare/github";

export default defineClawflareConfig({
  name: "my-agent",
  ai: {
    provider: "anthropic",
    model: "claude-3-5-sonnet-20241022"
  },
  plugins: [github()]
});
```

## Documentation

Full documentation is available in the `docs/` folder:

- [Quickstart](./docs/quickstart.md)
- [CLI Reference](./docs/cli.md)
- [Configuration](./docs/configuration.md)
- [Custom Tools](./docs/custom-tools.md)
- [Custom Egress](./docs/custom-egress.md)
- [AI Providers](./docs/ai-providers.md)
- [Troubleshooting](./docs/troubleshooting.md)
- [Deployment](./docs/deployment.md)

## Examples

See `examples/` folder for complete working projects:

- [minimal-agent](./examples/minimal-agent) - Simplest possible agent
- [github-agent](./examples/github-agent) - GitHub integration
- [cloudflare-agent](./examples/cloudflare-agent) - Cloudflare API management
- [stripe-egress-agent](./examples/stripe-egress-agent) - Custom egress handler

## Architecture

```
clawflare/
├── packages/
│   ├── cli/                # Published as "clawflare"
│   ├── runtime/            # Published as "@clawflare/runtime"
│   ├── egress-core/        # Published as "@clawflare/egress-core"
│   ├── github/             # Published as "@clawflare/github"
│   ├── cloudflare/         # Published as "@clawflare/cloudflare"
│   └── e2e/                # End-to-end tests
├── docs/                   # Documentation
└── examples/               # Example projects
```

### Technologies

- **AI Provider**: `@earendil-works/pi-ai` (Bedrock, Anthropic, OpenAI)
- **Agent Core**: `@earendil-works/pi-agent-core`
- **TUI**: `@earendil-works/pi-tui`
- **Persistence**: Cloudflare D1
- **Coordination**: Durable Objects (WebSocket, session serialization)
- **Execution**: Cloudflare Workflows (persistent sessions)
- **Dynamic Code**: Worker Loader API (`env.LOADER.load()`)
- **Containers**: Cloudflare Containers (optional)

## Development

### Setup

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm build

# Typecheck
pnpm typecheck

# Run tests
pnpm --filter @clawflare/runtime test

# Run E2E tests
pnpm test:e2e
```

### Monorepo Commands

```bash
# Build package
pnpm --filter @clawflare/runtime build

# Run dev server
pnpm dev

# Deploy to production
pnpm deploy:prod

# Run harness tests
pnpm --filter @clawflare/runtime test

# Apply D1 migrations
pnpm --filter @clawflare/runtime db:migrations:apply:local
pnpm --filter @clawflare/runtime db:migrations:apply:remote
```

### Container Workspace

Requires Cloudflare Containers feature.

```bash
# Build container image
cd packages/runtime/container-runtime
docker build -t clawflare-container .
```

## Testing

```bash
# Run all package tests
pnpm test

# Run E2E tests (creates temporary Worker and D1 resources)
pnpm test:e2e

# Keep resources after testing (for debugging)
pnpm test:e2e -- --keep-alive

# Interactive TUI testing
pnpm test:e2e:ui
```

## License

MIT

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md)