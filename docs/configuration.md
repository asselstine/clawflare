# Clawflare Configuration

The `clawflare.config.ts` file is your project's source of truth.

## Basic Configuration

```typescript
import { defineClawflareConfig } from "@clawflare/runtime";

export default defineClawflareConfig({
  name: "my-agent",
  ai: {
    provider: "anthropic",
    model: "claude-3-5-sonnet-20241022"
  }
});
```

## Configuration Options

### `name` (required)

The project name. Used for Worker naming, D1 database naming, and routing.

```typescript
name: "my-agent"
```

### `ai`

AI provider and model configuration.

```typescript
ai: {
  provider: "anthropic",     // or "openai", "bedrock", "cloudflare-workers-ai"
  model: "claude-3-5-sonnet-20241022"
}
```

**Supported Providers:**
- `anthropic` - Anthropic Claude models
- `openai` - OpenAI GPT models
- `bedrock` - Amazon Bedrock (default: minimax.mini_max-m2.5)
- `cloudflare-workers-ai` - Cloudflare Workers AI

**Provider Secrets:**
- Anthropic: `ANTHROPIC_API_KEY`
- OpenAI: `OPENAI_API_KEY`
- Bedrock: `AWS_BEARER_TOKEN_BEDROCK`

See [AI Providers](./ai-providers.md) for detailed configuration.

### `plugins`

Add plugins for tools and egress handlers.

```typescript
import { github } from "@clawflare/github";
import { cloudflare } from "@clawflare/cloudflare";

export default defineClawflareConfig({
  name: "my-agent",
  plugins: [
    github(),
    cloudflare()
  ]
});
```

**Official Plugins:**
- `@clawflare/github` - GitHub API egress and tools
- `@clawflare/cloudflare` - Cloudflare API egress

### `tools`

Define custom tools your agent can use.

```typescript
import { tools } from "./src/tools";

export default defineClawflareConfig({
  name: "my-agent",
  tools
});
```

See [Custom Tools](./custom-tools.md) for details.

### `egressHandlers`

Define custom egress handlers for outbound HTTP.

```typescript
import { egressHandlers } from "./src/egress";

export default defineClawflareConfig({
  name: "my-agent",
  egressHandlers
});
```

See [Custom Egress](./custom-egress.md) for details.

### `secrets`

Declare required secrets.

```typescript
export default defineClawflareConfig({
  name: "my-agent",
  secrets: [
    {
      name: "STRIPE_API_KEY",
      required: true,
      description: "Stripe API key for payment processing"
    }
  ]
});
```

### `cloudflare`

Advanced Cloudflare-specific options.

```typescript
export default defineClawflareConfig({
  name: "my-agent",
  cloudflare: {
    compatibilityDate: "2025-01-01",
    workerName: "my-agent-prod",
    routes: ["example.com/*"]
  }
});
```

## Full Example

```typescript
import { defineClawflareConfig } from "@clawflare/runtime";
import { github } from "@clawflare/github";
import { cloudflare } from "@clawflare/cloudflare";
import { tools } from "./src/tools";
import { egressHandlers } from "./src/egress";

export default defineClawflareConfig({
  name: "my-agent",
  
  ai: {
    provider: "anthropic",
    model: "claude-3-5-sonnet-20241022"
  },
  
  plugins: [
    github(),
    cloudflare()
  ],
  
  tools,
  egressHandlers,
  
  secrets: [
    {
      name: "CUSTOM_API_KEY",
      required: true,
      description: "API key for custom service"
    }
  ],
  
  cloudflare: {
    compatibilityDate: "2025-01-01"
  }
});
```