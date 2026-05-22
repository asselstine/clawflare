# Minimal Agent Example

The simplest possible Clawflare agent.

## Files

- `clawflare.config.ts` - Project configuration
- `package.json` - Dependencies and scripts
- `.gitignore` - Git ignore rules
- `.env.example` - Environment template

## Usage

```bash
# Copy example
cp -r examples/minimal-agent my-agent
cd my-agent

# Install dependencies
npm install

# Deploy
clawflare deploy

# Open TUI
clawflare open
```

## Configuration

The minimal config just needs a name:

```typescript
import { defineClawflareConfig } from "@clawflare/runtime";

export default defineClawflareConfig({
  name: "minimal-agent"
});
```

Uses default AI provider (Bedrock with Minimax) and built-in tools.