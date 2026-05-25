# AI Provider Configuration

Configure AI providers for your self-hosted Clawflare server.

## Supported Providers

Clawflare supports multiple AI providers:

- **Amazon Bedrock** - Minimax, Nova, and other models (default)
- **Anthropic** - Claude models
- **OpenAI** - GPT models
- **Cloudflare Workers AI** - Llama, Mistral, and other models

## Configuration

AI providers are configured via environment variables in `packages/server/.env`:

### Amazon Bedrock (Default)

```bash
AWS_BEARER_TOKEN_BEDROCK=your_aws_token
AWS_REGION=us-east-1
```

**Available models:**
- `minimax.minimax-m2.5` (default)
- `amazon.nova-pro-v1:0`
- `amazon.nova-lite-v1:0`
- `mistral.mistral-large-2402-v1:0`

Set the default model in `packages/server/.env`:
```bash
AI_PROVIDER=amazon-bedrock
AI_MODEL=minimax.minimax-m2.5
```

### Anthropic

```bash
ANTHROPIC_API_KEY=your_anthropic_key
AI_PROVIDER=anthropic
AI_MODEL=claude-3-5-sonnet-20241022
```

**Available models:**
- `claude-3-5-sonnet-20241022`
- `claude-3-5-haiku-20241022`
- `claude-3-opus-20240229`

### OpenAI

```bash
OPENAI_API_KEY=your_openai_key
AI_PROVIDER=openai
AI_MODEL=gpt-4o
```

**Available models:**
- `gpt-4o`
- `gpt-4o-mini`
- `gpt-4-turbo`

### Cloudflare Workers AI

```bash
AI_PROVIDER=cloudflare-workers-ai
AI_MODEL=@cf/meta/llama-3.1-8b-instruct
```

No additional API key needed - uses your Cloudflare account.

**Available models:**
- `@cf/meta/llama-3.1-70b-instruct`
- `@cf/meta/llama-3.1-8b-instruct`
- `@cf/mistral/mistral-7b-instruct-v0.1`

## Setting Secrets

Use Wrangler to set secrets on your deployed Worker:

```bash
cd packages/server

wrangler secret put AWS_BEARER_TOKEN_BEDROCK
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put AI_PROVIDER
wrangler secret put AI_MODEL
```

For local development, set them in `.env`.

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
