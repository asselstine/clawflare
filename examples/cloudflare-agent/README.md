# Cloudflare Agent Example

A Clawflare agent that manages Cloudflare resources.

## Features

- Cloudflare API access via `@clawflare/cloudflare` plugin
- List and manage Workers
- D1 database operations
- KV store management

## Setup

```bash
# Copy example
cp -r examples/cloudflare-agent my-agent
cd my-agent

# Install dependencies
npm install

# Deploy using existing Cloudflare token
clawflare deploy

# Open TUI
clawflare open
```

## Configuration

```typescript
import { cloudflare } from "@clawflare/cloudflare";

export default defineClawflareConfig({
  name: "cloudflare-agent",
  plugins: [cloudflare()],
  ai: {
    provider: "anthropic",
    model: "claude-3-5-sonnet-20241022"
  }
});
```

The Cloudflare API token is automatically used from the environment.

## Usage

Ask the agent about your Cloudflare account:
- "List all my Workers"
- "Show my D1 databases"
- "Get Worker logs for my-service"
- "Create a new KV namespace called config"