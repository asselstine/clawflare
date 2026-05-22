# Clawflare - Agent Onboarding Guide

## Project Overview

**Clawflare** is an AI agent harness that runs on Cloudflare Workers, providing a durable, multi-turn agent execution environment with tool support. D1 is the source of truth for persisted sessions, events, input queues, runtime state, stored code, and egress handler metadata.

## Package Structure

### 1. `packages/runtime/` - Core Cloudflare Worker

**Entry Points & Routing:**
- `src/index.ts` - Main Worker fetch handler, routing, auth, WebSocket upgrade
- `src/test-index.ts` - Test-only entrypoint with additional `__test/*` endpoints

**Core Logic:**
- `src/persistent-workflow.ts` - `PersistentSessionWorkflow` durable Cloudflare Workflow; drains D1 input queue and updates D1 session/runtime state
- `src/session-store.ts` - Session facade backed by D1 data layer; queue/event writes route through coordinator when available
- `src/session-coordinator.ts` - `ClawflareSessionCoordinator` Durable Object for per-session queue/event serialization
- `src/datastore.ts` - D1-backed compatibility datastore for stored code and egress handler metadata
- `src/data/` - Repository interfaces and D1 repository implementations
- `src/session-do.ts` - Legacy `ClawflareSessionStore`; deprecated, not an active source of truth
- `src/legacy-datastore-do.ts` - Legacy no-op `ClawflareDatastore` export for Durable Object migration-history compatibility

**Tools (4 base tools + 8 container tools):**
- `src/tools/index.ts` - Tool definitions:
  - `store_code` - Save reusable JavaScript by name
  - `execute_stored_code` - Run stored JavaScript  
  - `execute_code` - Run inline JavaScript in Dynamic Worker
  - `search` - Query stored code and egress handlers
- `src/container/` - Container workspace tools:
  - `coding-container.ts` - `CodingContainer` Cloudflare Container subclass with egress routing
  - `client.ts` - Container RPC client for calling runtime endpoints
  - `tools.ts` - 8 model-visible container tools
  - `ids.ts` - Container ID validation and generation
  - `paths.ts` - Path validation and workspace boundary checks
  - `output.ts` - Output truncation utilities

**Container Runtime:**
- `container-runtime/Dockerfile` - Debian-based image (node:22-bookworm-slim) with git, ripgrep
- `container-runtime/server.mjs` - HTTP server inside container: bash, read, write, edit, grep, find, ls, health

**Execution & Egress:**
- `src/runtime/dynamic-worker.ts` - `executeDynamicWorker()` - Isolated JavaScript execution via Worker Loader API
- `src/egress/gateway.ts` - `HttpGateway` class, `routeOutboundRequest()` for controlled outbound HTTP
- `src/egress/registry.ts` - `createEgressRegistry()` factory
- `src/egress/types.ts` - Re-exports from `@clawflare/egress-core`

**WebSocket:**
- `src/ws-session.ts` - `ClawflareWebSocketSession` Durable Object; accepts prompt messages, starts/wakes D1-backed workflow sessions, and sends final assistant messages

**Supporting:**
- `src/types.ts` - Public API TypeScript type definitions
- `src/internal-types/` - Worker/internal environment and runtime types
- `src/mock-ai.ts` - Mock AI stream for testing (`createMockStream()`, `shouldUseMockAI()`)
- `migrations/` - D1 migrations (`sessions`, `session_events`, `session_counters`, `session_input_queue`, `session_runtime`, `stored_code`, `egress_handlers`)

### 2. `packages/cli/` - TUI Client

- `src/client.ts` - `AgentClient` class - HTTP client for harness API, session polling, and WebSocket connection
- `src/tui-app.ts` - `ClawflareTUIApp` class - Full TUI using `@earendil-works/pi-tui`
- `src/skills.ts` - Agent Skills loader from `~/.agents/skills/` and project `.agents/skills/`
- `src/index.ts` - Entry point, argument parsing, `runCli()` function

### 3. `packages/egress-core/` - Shared Egress Types

- `src/index.ts` - `EgressHandler` interface, `EgressRegistry` class, `hostnameMatchesDomain()`

### 4. `packages/github/` - GitHub Egress Handler

- `src/index.ts` - GitHub API handler, registers for `api.github.com`, `github.com`, `raw.githubusercontent.com`

### 5. `packages/cloudflare/` - Cloudflare API Egress Handler

- `src/index.ts` - Cloudflare API handler, registers for `api.cloudflare.com`

### 6. `packages/e2e/` - End-to-End Tests

- `src/index.ts` - Complete E2E test suite:
  - Deploys brand-new remote Cloudflare Worker
  - Creates temporary remote D1 database
  - Applies D1 migrations
  - Runs API tests against `workers.dev` URL
  - Tears down Worker and D1 database on completion
  - Supports `--ui` flag for manual TUI testing
  - Supports `--keep-alive` flag for debugging

## API Endpoints

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/health` | GET | No | Health check |
| `/v1/chat` | POST | Yes | Start/resume D1-backed workflow session; returns `sessionId` and event cursor |
| `/v1/session/:id` | GET | Yes | Poll D1-backed session messages/events/status |
| `/v1/session/:id/close` | POST | Yes | Enqueue close event and mark session closed |
| `/v1/sessions` | GET | Yes | List D1-backed sessions; supports status/session filters |
| `/v1/context` | GET | Yes | Get current context |
| `/v1/context` | POST | Yes | Create new/fork context |
| `/v1/tools` | GET | Yes | List available tools |
| `/v1/info` | GET | Yes | Server info (provider, model) |
| `/v1/cf_debug` | GET | Yes | D1-backed session debug information |
| `/ws` | Upgrade | Yes | WebSocket prompt flow over D1-backed workflow sessions |

## Key Architecture Patterns

| Component | Technology |
|-----------|------------|
| AI Provider | `@earendil-works/pi-ai` (default: Amazon Bedrock) |
| Agent Core | `@earendil-works/pi-agent-core` |
| TUI | `@earendil-works/pi-tui` |
| Persistence | Cloudflare D1 |
| Coordination | Durable Objects (`ClawflareSessionCoordinator`, `ClawflareWebSocketSession`) |
| Workflows | Cloudflare Workflows (`PersistentSessionWorkflow`) |
| Dynamic Code | Worker Loader API (`env.LOADER.load()`) |
| Container | Cloudflare Containers (`CodingContainer`) |

## Environment Configuration

Harness uses `amazon-bedrock` with `minimax.minimax-m2.5` as defaults. Production deploys require real D1 database IDs in `packages/runtime/wrangler.jsonc` or an environment-specific Wrangler config.

| Variable | Purpose |
|----------|---------|
| `CLAWFLARE_API_TOKEN` | Harness API authentication (required) |
| `CF_API_TOKEN` / `CLOUDFLARE_API_TOKEN` | Cloudflare API token for deploy/E2E; needs Workers Scripts:Edit, D1:Edit, Account Settings:Read |
| `AI_PROVIDER` | AI provider (default: `amazon-bedrock`) |
| `AI_MODEL` | Model ID (default: `minimax.minimax-m2.5`) |
| `AWS_BEARER_TOKEN_BEDROCK` | AWS bearer token for Bedrock |
| `AWS_REGION` | AWS region (default: `us-east-1`) |
| `MOCK_AI` | Enable mock AI mode for testing |

## CI/CD

No CI/CD defined. Use `pnpm typecheck`, `pnpm --filter @clawflare/runtime test`, `pnpm build`, and `pnpm test` for validation; use `pnpm deploy:prod` for production deployment.

## Testing

- `pnpm --filter @clawflare/runtime test` - Run harness unit tests, including D1 migration/repository concurrency tests
- `pnpm test` - Run remote E2E tests (deploys test Worker, creates D1 DB, applies migrations, runs tests, tears down)
- `pnpm test -- --keep-alive` - Keep test Worker/D1 resources after tests for debugging
- `pnpm cli` - Launch TUI for local development

### Container Tests

E2E tests include container functionality:
- Container lifecycle (create, health check)
- Bash command execution (`echo ok`, `git --version`)
- File operations (write, read, edit, ls, find)
- Content search (grep)
- Git clone over HTTPS with MITM TLS

Note: Container tests require the Cloudflare Containers feature enabled on your account.

## Development Commands

```bash
# Install dependencies
pnpm install

# Local development
pnpm dev

# Build all packages
pnpm build

# Type check
pnpm typecheck

# Run harness unit tests
pnpm --filter @clawflare/runtime test

# Run E2E tests
pnpm test

# Apply local D1 migrations
pnpm --filter @clawflare/runtime db:migrations:apply:local

# Apply remote D1 migrations
pnpm --filter @clawflare/runtime db:migrations:apply:remote

# Deploy to production
pnpm deploy:prod
```
