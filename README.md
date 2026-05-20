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

The harness uses `amazon-bedrock` with `minimax.minimax-m2.5` as the default AI provider and model. You can customize these via environment variables or wrangler configuration. `AI_PROVIDER` and `AI_MODEL` are used at runtime to select the actual `pi-ai` provider/model; set the matching provider API key as a Worker secret or local env variable.

#### AI Provider Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `AI_PROVIDER` | `amazon-bedrock` | AI provider to use (anthropic, openai, cloudflare-workers-ai, etc.) |
| `AI_MODEL` | `minimax.minimax-m2.5` | Model ID to use |
| `AWS_BEARER_TOKEN_BEDROCK` | - | AWS bearer token for Bedrock authentication |
| `AWS_REGION` | `us-east-1` | AWS region for Bedrock |
| `AWS_PROFILE` | - | AWS profile (alternative to bearer token) |
| Provider API keys | - | For non-Bedrock providers, set the provider's key, e.g. `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `MISTRAL_API_KEY`, etc. |

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

The project includes comprehensive E2E tests that deploy a brand-new remote Cloudflare Worker test instance, tag the Worker version as `e2e`, run the API tests against its `workers.dev` URL, then tear down the Worker:

```bash
# Run all automated remote E2E tests (uses mock AI)
pnpm test

# Keep the remote test Worker after tests for debugging
pnpm test -- --keep-alive

# Expected tests:
# - Health check (unauthenticated)
# - Authentication (missing token, wrong token, valid token)
# - Context management (get/create/fork)
# - Workflow-backed chat/prompt functionality
# - Tool listing
# - Stored code and Dynamic Worker execution
# - Controlled egress
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
│   ├── e2e/          # Remote end-to-end tests
│   ├── egress-core/  # Shared egress handler types/registry
│   ├── github/       # GitHub egress handler
│   └── cloudflare/   # Cloudflare API egress handler
└── package.json
```

### Running Locally

```bash
# Development mode
pnpm dev

# Build a specific package
pnpm --filter @clawflare/harness build
```

### Chat Workflows

`POST /v1/chat` starts a durable Cloudflare Workflow and returns immediately with an instance ID and `pollUrl`. Clients should poll `GET /v1/workflow/:instanceId` until the status is no longer `running`. The CLI does this automatically.

The WebSocket endpoint `/ws` is backed by a Durable Object. It starts workflows for prompt messages and sends workflow status updates plus the final chat response over the socket.

### Tools, Dynamic Code, Egress, and Skills

Clawflare exposes exactly four built-in model-visible tools:

- `execute_code` - run JavaScript in an isolated Dynamic Worker
- `store_code` - save reusable JavaScript by name
- `execute_stored_code` - run previously stored JavaScript by name
- `search` - query stored code and egress handler metadata

Reusable behavior should be saved with `store_code` instead of adding more model-visible tools. Network access from dynamic code is blocked unless an egress handler supports the target domain. GitHub and Cloudflare egress support is provided by `@clawflare/github` and `@clawflare/cloudflare`.

Skills are loaded by the CLI from generic Agent Skills locations (`~/.agents/skills/` and project `.agents/skills/`) and sent to the harness as prompt context.

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
