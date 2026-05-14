# Clawflare Harness

The core Clawflare agent harness runs in a Cloudflare Worker and is powered by `@earendil-works/pi-agent-core`.

## Quick Start

```bash
cd packages/harness
pnpm install
pnpm dev
```

## Cloudflare Bindings

The harness uses:

- `AGENT_SESSION` KV namespace for conversation state
- `DATASTORE` SQLite Durable Object for stored code and egress handler metadata
- `LOADER` Worker Loader binding for Dynamic Worker execution

`wrangler.jsonc` configures the Worker Loader and SQLite Durable Object migration.

## Secrets and Variables

```bash
npx wrangler secret put CLAWFLARE_API_TOKEN
npx wrangler secret put AWS_BEARER_TOKEN_BEDROCK
npx wrangler secret put CLOUDFLARE_API_TOKEN
npx wrangler secret put CLOUDFLARE_ACCOUNT_ID
# optional
npx wrangler secret put GITHUB_TOKEN
```

## API Endpoints

- `POST /v1/chat` - send a prompt or command
- `GET /v1/context` - get current context
- `POST /v1/context` - create a new context
- `GET /v1/tools` - list available model-visible tools
- `GET /v1/info` - provider/model metadata
- `GET /health` - health check

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

Dynamic code receives constrained capabilities only. It does not receive raw Cloudflare/GitHub tokens, raw KV namespaces, or the datastore binding.

## Egress

Network egress from Dynamic Workers is routed through `HttpGateway`. Unsupported outbound requests are blocked with `403`.

Built-in egress packages:

- `@clawflare/github` for `api.github.com`, `github.com`, and `raw.githubusercontent.com`
- `@clawflare/cloudflare` for `api.cloudflare.com`

Enabled handler metadata is stored in the SQLite Durable Object.

## Skills

Skills are not stored or served by the harness. The CLI loads generic Agent Skills locally from `~/.agents/skills/` and project `.agents/skills/` directories, then includes relevant skill context in prompts sent to the harness.
