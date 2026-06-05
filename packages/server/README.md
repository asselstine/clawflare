# Clawflare Server

`@clawflare/server` is the Cloudflare Worker implementation of the Clawflare hosted server. It provides the Worker entrypoint, Durable Object bindings, workflow integration, data layer, HTTP routes, WebSocket session handling, and server integrations.

## Quick Start

From the repository root:

```bash
pnpm install
pnpm --filter @clawflare/server dev
```

Or from the server package directory:

```bash
cd packages/server
pnpm dev
```

## Configuration

The server uses a checked-in `wrangler.jsonc` as the source of truth. Edit this file directly for configuration changes.

### Required Configuration

Ensure `wrangler.jsonc` has the correct D1 database IDs:

```jsonc
{
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "clawflare",
      "database_id": "your-production-database-id",
      "preview_database_id": "your-preview-database-id",
      "migrations_dir": "migrations"
    }
  ]
}
```

### Getting D1 Database IDs

```bash
# Create a new database
npx wrangler d1 create clawflare

# Or list existing databases
npx wrangler d1 list
```

## Cloudflare Bindings

The server uses:

- `DB` D1 database for persistent sessions, events, stored code, and egress handler metadata
- `WEBSOCKET_SESSION` Durable Object for WebSocket connections
- `LOADER` Worker Loader binding for Dynamic Worker execution
- `AGENT_WORKFLOW` Workflow for durable agent execution
- `HTTP_GATEWAY` Service binding for controlled outbound HTTP from Dynamic Workers
- `SECRET_BROKER` Service binding for envelope-encrypted model provider secrets
- `CLAWFLARE_KEK` secret binding containing a base64-encoded 32-byte key encryption key

`wrangler.jsonc` configures these bindings directly.

## Models

AI providers are configured per-workspace via the API, not via Wrangler secrets. Provider secrets are envelope-encrypted: each provider secret gets a data encryption key, and encrypted secret payloads plus encrypted DEKs are stored in D1. The Worker only needs one app-bound key encryption key, `CLAWFLARE_KEK`.

Create the KEK once and keep it stable for the lifetime of stored model secrets:

```bash
openssl rand -base64 32
pnpm --filter @clawflare/server exec wrangler secret put CLAWFLARE_KEK
```

Users must:

1. Use `clawflare providers add` CLI command to add a provider
2. Use `/models` in the TUI to select the default model

Supported providers include: amazon-bedrock, anthropic, openai, and others from pi-ai.

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
- `GET /v1/users/me` - get current user and workspace info
- `GET /v1/workspace` - get current workspace
- `GET /v1/session/:id` - poll session messages/events/status
- `POST /v1/session/:id/close` - close a session
- `GET /v1/sessions` - list sessions
- `GET /v1/tools` - list available model-visible tools
- `GET /v1/providers` - list supported providers
- `GET /v1/providers/configured` - list configured workspace providers
- `GET /v1/models` - list configured workspace models
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

Egress handlers are configured per-workspace through the API/CLI. Secrets are stored as encrypted secret refs, while non-secret params are stored in D1:

```bash
clawflare egress list --available
clawflare egress add
clawflare egress list --all
clawflare egress disable github
clawflare egress enable github
```

Enabled handler metadata, config params, and encrypted secret references are stored in D1.

## Deployment

For production deployment:

```bash
# Ensure wrangler.jsonc is configured with correct database IDs
# Deploy via Wrangler
pnpm deploy
```

The deploy script will check and set
