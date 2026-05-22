# AI Provider Configuration

Configure different AI providers for your Clawflare agent.

## Overview

Clawflare supports multiple AI providers through the `pi-ai` abstraction:

- **Anthropic** - Claude models
- **OpenAI** - GPT models  
- **Amazon Bedrock** - Minimax, Nova, and other models
- **Cloudflare Workers AI** - Llama, Mistral, and other models

## Anthropic

```typescript
// clawflare.config.ts
export default defineClawflareConfig({
  name: "my-agent",
  ai: {
    provider: "anthropic",
    model: "claude-3-5-sonnet-20241022"
  }
});
```

**Setup:**
```bash
# Set your API key
clawflare secret set ANTHROPIC_API_KEY
# or
npx wrangler secret put ANTHROPIC_API_KEY
```

**Available models:**
- `claude-3-5-sonnet-20241022`
- `claude-3-5-haiku-20241022`
- `claude-3-opus-20240229`

## OpenAI

```typescript
export default defineClawflareConfig({
  name: "my-agent",
  ai: {
    provider: "openai",
    model: "gpt-4o"
  }
});
```

**Setup:**
```bash
clawflare secret set OPENAI_API_KEY
```

**Available models:**
- `gpt-4o`
- `gpt-4o-mini`
- `gpt-4-turbo`

## Amazon Bedrock (Default)

```typescript
export default defineClawflareConfig({
  name: "my-agent",
  ai: {
    provider: "bedrock",
    model: "minimax.minimax-m2.5"
  }
});
```

**Setup:**
```bash
# Option 1: Bearer token (temporary)
clawflare secret set AWS_BEARER_TOKEN_BEDROCK

# Option 2: AWS profile
export AWS_PROFILE=your-profile
```

**Environment variables:**
- `AWS_BEARER_TOKEN_BEDROCK` - AWS bearer token
- `AWS_REGION` - AWS region (default: `us-east-1`)
- `AWS_PROFILE` - AWS CLI profile name

**Available models:**
- `minimax.minimax-m2.5` (default)
- `amazon.nova-pro-v1:0`
- `amazon.nova-lite-v1:0`
- `mistral.mistral-large-2402-v1:0`

## Cloudflare Workers AI

```typescript
export default defineClawflareConfig({
  name: "my-agent",
  ai: {
    provider: "cloudflare-workers-ai",
    model: "@cf/meta/llama-3.1-70b-instruct"
  }
});
```

**Setup:**
No additional API key needed - uses your Cloudflare account.

**Available models:**
- `@cf/meta/llama-3.1-70b-instruct`
- `@cf/meta/llama-3.1-8b-instruct`
- `@cf/mistral/mistral-7b-instruct-v0.1`

## Environment Variable Override

Set provider and model via environment variables:

```bash
export AI_PROVIDER=anthropic
export AI_MODEL=claude-3-5-sonnet-20241022
```

These override config file settings.

## Provider Comparison

| Provider | Latency | Quality | Cost | Setup |
|----------|---------|---------|------|-------|
| Bedrock | Medium | High | Low | AWS auth |
| Anthropic | Low | Very High | Medium | API key |
| OpenAI | Low | Very High | Medium | API key |
| Workers AI | Very Low | Good | Very Low | None |

## Model Selection Tips

- **Code tasks**: Claude 3.5 Sonnet, GPT-4o
- **Fast responses**: Claude 3.5 Haiku, GPT-4o-mini, Workers AI
- **Complex reasoning**: Claude 3.5 Sonnet, GPT-4o
- **Cost optimization**: Bedrock Minimax, Workers AI