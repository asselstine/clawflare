# Clawflare Runtime

`@clawflare/runtime` is the Cloudflare Worker runtime for Clawflare agents. It provides the Worker entrypoint, Durable Object bindings, workflow integration, data layer, HTTP routes, WebSocket session handling, and runtime extension APIs.

## Quick Start

From the repository root:

```bash
pnpm install
pnpm --filter @clawflare/runtime dev
```

Or from the runtime package directory:

```bash
cd packages/runtime
pnpm dev
```

## Configuration

The harness uses a **template-based configuration** to separate complex Worker setup from environment-specific values.

### Template-based Configuration

Instead of editing `wrangler.jsonc` directly, use the template system:

1. **Copy the environment example**:
   ```bash
   cp .env.example .env
   ```

2. **Fill in your values** in `.env`:
   ```bash
   # Required: D1 Database IDs
   DATABASE_ID=your-production-database-id
   
   # Optional: AI configuration (has defaults)
   AI_PROVIDER=amazon-bedrock
   AI_MODEL=minimax.minimax-m2.5
   ```

3. **Generate wrangler.jsonc** from the template:
   ```bash
   pnpm generate:config
   ```

This substitutes your environment variables into `wrangler.template.jsonc` and outputs `wrangler.jsonc`.

### Getting D1 Database IDs

```bash
# Or list existing databases
npx wrangler d1 list
```

## Cloudflare Bindings

The harness uses:

- `DB` D1 database for persistent sessions, events, stored code, and egress handler metadata
- `WEBSOCKET_SESSION` Durable Object for WebSocket connections
- `LOADER` Worker Loader binding for Dynamic Worker execution
- `AGENT_WORKFLOW` Workflow for durable agent execution
- `HTTP_GATEWAY` Service binding for controlled outbound HTTP from Dynamic Workers

`wrangler.template.jsonc` configures these bindings with placeholder values for substitution.

## Secrets and Variables

Set production secrets via Wrangler:

```bash
npx wrangler secret put CLAWFLARE_API_TOKEN
npx wrangler secret put AWS_BEARER_TOKEN_BEDROCK
npx wrangler secret put CLOUDFLARE_API_TOKEN
npx wrangler secret put CLOUDFLARE_ACCOUNT_ID
npx wrangler secret put GITHUB_TOKEN  # optional
```

For local development, create `.dev.vars`:

```bash
CLAWFLARE_API_TOKEN=your-token
AWS_BEARER_TOKEN_BEDROCK=your-aws-token
```

## Database Migrations

```bash
# Create a new migration
pnpm db:migrations:create <migration_name>

# Apply to local database
pnpm db:migrations:apply:local

# Apply to remote/production database
pnpm db:migrations:apply:remote

# List migrations
pnpm db:migrations:list
```

## API Endpoints

- `POST /v1/chat` - send a prompt or command
- `GET /v1/session/:id` - poll session messages/events/status
- `POST /v1/session/:id/close` - close a session
- `GET /v1/sessions` - list sessions
- `GET /v1/context` - get current context
- `POST /v1/context` - create a new context
- `GET /v1/tools` - list available model-visible tools
- `GET /v1/info` - provider/model metadata
- `GET /health` - health check
- `/ws` - WebSocket upgrade for real-time sessions

All endpoints except `/health` require a bearer token:

```bash
curl -H "Authorization: Bearer YOUR_TOKEN" \
  https://your-worker.workers.dev/v1/tools
```

## Model-Visible Tools

The agent exposes exactly four model-visible tools:

- `execute_code` - run JavaScript in an isolated Dynamic Worker
- `store_code` - save reusable JavaScript by name
- `execute_stored_code` - run previously stored JavaScript by name
- `search` - query stored code and egress handler metadata

Dynamic code receives constrained capabilities only. It does not receive raw Cloudflare/GitHub tokens or database bindings.

## Egress

Network egress from Dynamic Workers is routed through `HttpGateway`. Registered egress handlers get first chance to handle matching domains; all other HTTP requests fall back to generic outbound `fetch`.

Built-in egress packages:

- `@clawflare/github` for `api.github.com`, `github.com`, `raw.githubusercontent.com`, and `codeload.github.com`
- `@clawflare/cloudflare` for `api.cloudflare.com`

GitHub REST API requests receive API-specific headers and optional `GITHUB_TOKEN` auth. Raw content and codeload archives pass through without REST JSON headers. Native Git smart-HTTP pass-through is enabled by default and can be disabled with `GITHUB_SMART_HTTP_EGRESS=disabled`.

Enabled handler metadata is stored in D1.

## Skills

Skills are not stored or served by the harness. The CLI loads generic Agent Skills locally from `~/.agents/skills/` and project `.agents/skills/` directories, then includes relevant skill context in prompts sent to the harness.

## Environment-Specific Deployment

For production deployment with specific environment configs:

```bash
# Ensure environment variables are set
export DATABASE_ID=prod-db-id
export PREVIEW_DATABASE_ID=prod-preview-db-id
export AI_PROVIDER=amazon-bedrock
export AI_MODEL=minimax.minimax-m2.5

# Generate config and deploy
pnpm generate:config
pnpm deploy
```
