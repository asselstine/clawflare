# Clawflare

An agent harness that runs directly on Cloudflare infrastructure as a worker.

## Usage

### Prerequisites

- Node.js 22+
- pnpm 9+
- Cloudflare account with an API token that can manage Workers and D1
- AWS account with Bedrock access (for default AI provider)

### Cloudflare API Token Permissions

For deployment and remote E2E tests, use a Cloudflare API token scoped to the target account with at least:

| Scope | Permission |
|-------|------------|
| Account | Workers Scripts:Edit |
| Account | D1:Edit |
| Account | Account Settings:Read |

If you deploy route-based Workers instead of `workers.dev`, also grant the relevant zone route permissions.

Remote E2E tests create and delete temporary Workers and D1 databases, so `D1:Edit` is required; `D1:Read` is not enough.

### D1 Database Setup

Clawflare uses Cloudflare D1 as its source of truth for sessions, events, input queues, runtime state, stored code, and egress handler metadata. Durable Objects are used for WebSocket connections and per-session coordination, not as the primary database.

#### Create the D1 database

```bash
cd packages/harness
wrangler d1 create clawflare
```

Copy the database ID from the output.

#### Configure with Templates (Recommended)

Instead of manually editing `wrangler.jsonc`, use environment-based substitution:

```bash
# 1. Create environment file
cp packages/harness/.env.example packages/harness/.env

# 2. Edit with your database IDs and preferences
# Required: DATABASE_ID and PREVIEW_DATABASE_ID from `wrangler d1 create` output
# Optional: AI_PROVIDER, AI_MODEL (have defaults)

# 3. Generate wrangler.jsonc from template
pnpm --filter @clawflare/harness generate:config
```

#### Manual Configuration (Alternative)

Edit `packages/harness/wrangler.jsonc` directly, replacing the placeholder values.

#### Apply migrations

Local development:
```bash
pnpm --filter @clawflare/harness db:migrations:apply:local
```

Remote (production):
```bash
pnpm --filter @clawflare/harness db:migrations:apply:remote
```

Current migrations create:

- `sessions`
- `session_events`
- `session_counters`
- `session_input_queue`
- `session_runtime`
- `stored_code`
- `egress_handlers`

#### Data migration policy

Clawflare uses a greenfield D1 cutover: existing legacy Durable Object session data is not migrated automatically. New sessions, events, queues, stored code, and egress metadata are stored in D1.

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

The project includes comprehensive E2E tests that deploy a brand-new remote Cloudflare Worker test instance, create a temporary remote D1 database, apply migrations, tag the Worker version as `e2e`, run API tests against its `workers.dev` URL, then tear everything down:

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
# - Session polling/listing
# - WebSocket prompt flow
# - Tool listing
# - Stored code and Dynamic Worker execution
# - Controlled egress
# - Search over stored code and egress handlers
# - Container workspace (create, bash, file ops, git clone)
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

# Typecheck all packages
pnpm typecheck

# Run harness unit tests
pnpm --filter @clawflare/harness test

# Generate wrangler.jsonc from template
pnpm --filter @clawflare/harness generate:config

# Create database migration
pnpm --filter @clawflare/harness db:migrations:create <name>

# Apply local migrations
pnpm --filter @clawflare/harness db:migrations:apply:local

# Apply remote migrations
pnpm --filter @clawflare/harness db:migrations:apply:remote
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `CF_API_TOKEN` / `CLOUDFLARE_API_TOKEN` | Cloudflare API token with Workers Scripts:Edit, D1:Edit, and Account Settings:Read |
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
│   │   ├── src/container/       # Container workspace tools
│   │   └── container-runtime/   # Container image and runtime server
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

### Container Workspace

Clawflare supports an isolated container workspace via Cloudflare Containers. The container provides:

- Debian-based environment with Node.js, git, ripgrep, and dev tools
- Persistent filesystem at `/workspace` per session
- MITM HTTPS for controlled outbound traffic via egress handlers
- 8 model-visible tools: `container_create`, `container_bash`, `container_read`, `container_write`, `container_edit`, `container_grep`, `container_find`, `container_ls`

**Requirements:**
- Cloudflare Containers requires Docker to build images
- Ensure Docker CLI is installed and the daemon is running before deploying

**Configuration:**
The container is configured in `wrangler.jsonc`:
```json
{
  "containers": [{
    "class_name": "CodingContainer",
    "image": "./container-runtime/Dockerfile",
    "max_instances": 10,
    "instance_type": "lite"
  }]
}
```

`POST /v1/chat` starts or resumes a D1-backed session and returns immediately with a `sessionId` and event cursor. Clients poll `GET /v1/session/:sessionId` until the session status is `idle`, `error`, `closed`, or `expired`. Follow-up prompts reuse the same `sessionId`.

Session input is persisted in D1 and serialized through `ClawflareSessionCoordinator`, a per-session Durable Object. The persistent Cloudflare Workflow drains the queued input, appends events to D1, and updates session runtime state.

The WebSocket endpoint `/ws` is backed by `ClawflareWebSocketSession`. It accepts prompt messages, starts/wakes the same D1-backed workflow path, and sends the final assistant message over the socket.

### Tools, Dynamic Code, Egress, Container Workspace, and Skills

Clawflare exposes four base model-visible tools plus eight container workspace tools:

**Base Tools:**
- `execute_code` - run JavaScript in an isolated Dynamic Worker
- `store_code` - save reusable JavaScript by name
- `execute_stored_code` - run previously stored JavaScript by name
- `search` - query stored code and egress handler metadata

**Container Tools:**
- `container_create` - create/initialize a persistent coding container
- `container_bash` - execute shell commands in the workspace
- `container_read` - read text files with optional line ranges  
- `container_write` - write or append to files
- `container_edit` - make surgical edits with exact string replacement
- `container_grep` - search file contents (uses ripgrep)
- `container_find` - find files/directories by name/type
- `container_ls` - list directory contents

The container provides an isolated Debian-based environment with Node.js, git, ripgrep, and development tools. All filesystem operations are confined to `/workspace`. Container egress routes through the same egress gateway as Dynamic Workers, with MITM HTTPS intercepting outbound requests. Reusable behavior should be saved with `store_code` instead of adding more model-visible tools. Registered egress handlers get first chance to handle matching domains; all other HTTP requests fall back to generic outbound `fetch`. GitHub and Cloudflare egress support is provided by `@clawflare/github` and `@clawflare/cloudflare`.

GitHub egress classifies traffic by host/path. REST API requests to `api.github.com` receive GitHub API headers and optional `GITHUB_TOKEN` auth. Raw content (`raw.githubusercontent.com`) and archives (`codeload.github.com`) pass through without REST JSON headers. Native Git smart-HTTP pass-through is enabled by default and can be disabled with `GITHUB_SMART_HTTP_EGRESS=disabled`.

Skills are loaded by the CLI from generic Agent Skills locations (`~/.agents/skills/` and project `.agents/skills/`) and sent to the harness as prompt context.

### Deploying

Before deploying production, generate the config with your D1 database IDs:

```bash
# Ensure DATABASE_ID and PREVIEW_DATABASE_ID are set
pnpm --filter @clawflare/harness generate:config
```

Apply remote migrations first:

```bash
pnpm --filter @clawflare/harness db:migrations:apply:remote
```

Then deploy:

```bash
pnpm deploy:prod
```

For a dry run:

```bash
cd packages/harness
pnpm exec wrangler deploy --dry-run
```
