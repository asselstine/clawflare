# Clawflare

An agent harness that runs directly on Cloudflare infrastructure as a worker.

## Usage

### Prerequisites

- Node.js 22+
- pnpm 9+
- Cloudflare account with API token
- AWS account with Bedrock access (for default AI provider)

### Setup

```bash
# Install dependencies
pnpm install

# Set up your credentials
cp .env.example .env
# Edit .env and add your CF_API_TOKEN and AWS_BEARER_TOKEN_BEDROCK
```

### Configuration

The harness uses `amazon-bedrock` with `minimax.minimax-m2.5` as the default AI provider and model. You can customize these via environment variables or wrangler configuration.

#### AI Provider Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `AI_PROVIDER` | `amazon-bedrock` | AI provider to use (anthropic, openai, cloudflare-workers-ai, etc.) |
| `AI_MODEL` | `minimax.minimax-m2.5` | Model ID to use |
| `AWS_BEARER_TOKEN_BEDROCK` | - | AWS bearer token for Bedrock authentication |
| `AWS_REGION` | `us-east-1` | AWS region for Bedrock |
| `AWS_PROFILE` | - | AWS profile (alternative to bearer token) |

Setup the AWS bearer token secret:

```bash
cd packages/harness
npx wrangler secret put AWS_BEARER_TOKEN_BEDROCK
# Enter your bearer token when prompted
```

For local development, add `AWS_BEARER_TOKEN_BEDROCK` to your `.env` file.

#### Other Providers

To use a different provider, update `AI_PROVIDER` and `AI_MODEL` in your `.env` or `wrangler.jsonc`:

```bash
# Example: Use Anthropic Claude
AI_PROVIDER=anthropic
AI_MODEL=claude-3-5-sonnet-20241022
```

### E2E Testing

The project includes comprehensive E2E tests that automatically deploy the harness locally and test all API endpoints:

```bash
# Run all automated E2E tests (uses mock AI)
pnpm test

# Expected tests:
# - Health check (unauthenticated)
# - Authentication (missing token, wrong token, valid token)
# - Context management (get/create/fork)
# - Chat/prompt functionality
# - Tool listing
# - Skills listing
# - 404 handling
```

### Commands

```bash
# Deploy to production (Cloudflare Workers)
pnpm deploy:prod

# Run E2E tests (deploys test instance, runs tests)
pnpm test

# Interactive TUI testing
pnpm test:ui

# Run development server locally
pnpm dev

# Build all packages
pnpm build
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `CF_API_TOKEN` | Cloudflare API token with Workers, D1, KV permissions |
| `CF_WORKER_NAME` | Worker name (default: clawflare-harness) |
| `CF_ACCOUNT_ID` | Cloudflare account ID (optional, auto-detected) |
| `AI_PROVIDER` | AI provider (default: amazon-bedrock) |
| `AI_MODEL` | Model ID (default: minimax.minimax-m2.5) |
| `AWS_BEARER_TOKEN_BEDROCK` | AWS bearer token for Bedrock auth |
| `AWS_REGION` | AWS region (default: us-east-1) |
| `AWS_PROFILE` | AWS profile name (alternative auth) |
| `MOCK_AI` | Enable mock AI mode (default: false) |

## Development

### Project Structure

```
clawflare/
├── packages/
│   ├── cli/          # TUI client for agent communication
│   ├── harness/      # Cloudflare Worker runtime
│   └── e2e/          # End-to-end tests
├── scripts/
│   └── deploy-test.ts # Deploy and test script
└── package.json
```

### Running Locally

```bash
# Development mode (uses mock AI unless CF_API_TOKEN is set)
pnpm dev

# Build a specific package
pnpm --filter @clawflare/harness build
```

### Adding Tools

Tools are defined in `packages/tools/`. Each tool is a function that executes a Cloudflare API call and returns results.

### Deploying

To redeploy after code changes:

```bash
cd packages/harness
npx wrangler deploy src/index.ts --name clawflare-harness
```

Or use the npm script:

```bash
pnpm deploy:prod
```
