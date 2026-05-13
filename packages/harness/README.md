# Clawflare Harness

The core agent harness that runs in a Cloudflare Worker, powered by `@earendil-works/pi-agent-core`.

## Quick Start

### 1. Install dependencies

```bash
cd packages/harness
pnpm install
```

### 2. Configure

Create a KV namespace for storing skills and agent state:

```bash
npx wrangler kv:namespace create SKILLS
npx wrangler kv:namespace create AGENT_STATE
```

Update `wrangler.jsonc` with the namespace IDs.

### 3. Set secrets

```bash
# Set your API token for authentication
npx wrangler secret put API_TOKEN

# Set your Cloudflare API token (for calling CF API)
npx wrangler secret put CLOUDFLARE_API_TOKEN
```

### 4. Deploy

```bash
pnpm deploy
# or
npx wrangler deploy
```

## API Endpoints

Once deployed, the harness exposes:

- `POST /v1/chat` - Send a prompt or command
- `GET /v1/context` - Get current context
- `POST /v1/context` - Create a new context
- `GET /v1/skills` - List skills
- `GET /v1/tools` - List available tools
- `GET /health` - Health check

### Authentication

All endpoints (except `/health`) require a Bearer token:

```bash
curl -H "Authorization: Bearer YOUR_API_TOKEN" \
  https://your-worker.workers.dev/v1/chat \
  -d '{"type":"prompt","content":"Hello"}'
```

## Configuration

| Environment Variable | Description |
|---------------------|-------------|
| `API_TOKEN` | Bearer token for authentication (set via `wrangler secret put`) |
| `CLOUDFLARE_API_TOKEN` | Cloudflare API token for managing resources |

## Tools

The agent has these built-in tools:

- `deploy_tool` - Deploy a new Cloudflare Worker
- `execute_code` - Execute JavaScript code in a dynamic worker
- `list_workers` - List all Workers
- `get_worker` - Get Worker details
- `create_kv` - Create a KV namespace
- `create_d1` - Create a D1 database
- `list_resources` - List all Cloudflare resources