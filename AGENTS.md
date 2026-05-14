# Clawflare - Agent Onboarding Guide

## Project Overview

**Clawflare** is an AI agent harness that runs on Cloudflare Workers, providing a durable, multi-turn agent execution environment with tool support.

## Package Structure

### 1. `packages/harness/` - Core Cloudflare Worker

**Entry Points & Routing:**
- `src/index.ts` - Main Worker fetch handler, routing, auth, WebSocket upgrade
- `src/test-index.ts` - Test-only entrypoint with additional `__test/*` endpoints

**Core Logic:**
- `src/agent.ts` - `ClawflareAgentWrapper` class, chat handling, context management, AI streaming
- `src/workflow-agent.ts` - `Workflow` class for durable Cloudflare Workflow execution
- `src/datastore.ts` - SQLite-backed Durable Object (`ClawflareDatastore`) for stored code and egress handlers

**Tools (4 model-visible tools only):**
- `src/tools/index.ts` - Tool definitions:
  - `store_code` - Save reusable JavaScript by name
  - `execute_stored_code` - Run stored JavaScript
  - `execute_code` - Run inline JavaScript in Dynamic Worker
  - `search` - Query stored code and egress handlers

**Execution & Egress:**
- `src/runtime/dynamic-worker.ts` - `executeDynamicWorker()` - Isolated JavaScript execution via Worker Loader API
- `src/egress/gateway.ts` - `HttpGateway` class, `routeOutboundRequest()` for controlled outbound HTTP
- `src/egress/registry.ts` - `createEgressRegistry()` factory
- `src/egress/types.ts` - Re-exports from `@clawflare/egress-core`

**WebSocket:**
- `src/ws-session.ts` - `ClawflareWebSocketSession` Durable Object for persistent workflow sessions

**Supporting:**
- `src/types.ts` - TypeScript type definitions (Env, ChatRequest, etc.)
- `src/mock-ai.ts` - Mock AI stream for testing (`createMockStream()`, `shouldUseMockAI()`)

### 2. `packages/cli/` - TUI Client

- `src/client.ts` - `AgentClient` class - HTTP client for harness API, workflow polling
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
  - Creates temporary KV namespace
  - Runs 30+ API tests against `workers.dev` URL
  - Tears down Worker and KV on completion
  - Supports `--ui` flag for manual TUI testing
  - Supports `--keep-alive` flag for debugging

## API Endpoints

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/health` | GET | No | Health check |
| `/v1/chat` | POST | Yes | Start workflow-backed chat |
| `/v1/workflow/:id` | GET | Yes | Poll workflow status |
| `/v1/context` | GET | Yes | Get current context |
| `/v1/context` | POST | Yes | Create new/fork context |
| `/v1/tools` | GET | Yes | List available tools |
| `/v1/info` | GET | Yes | Server info (provider, model) |
| `/ws` | - | Yes | WebSocket upgrade for streaming |

## Key Architecture Patterns

| Component | Technology |
|-----------|------------|
| AI Provider | `@earendil-works/pi-ai` (default: Amazon Bedrock) |
| Agent Core | `@earendil-works/pi-agent-core` |
| TUI | `@earendil-works/pi-tui` |
| Persistence | Cloudflare KV + SQLite Durable Objects |
| Workflows | Cloudflare Workflows (`Workflow`) |
| Dynamic Code | Worker Loader API (`env.LOADER.load()`) |

## Environment Configuration

Harness uses `amazon-bedrock` with `minimax.minimax-m2.5` as defaults.

| Variable | Purpose |
|----------|---------|
| `CLAWFLARE_API_TOKEN` | API authentication (required) |
| `AI_PROVIDER` | AI provider (default: `amazon-bedrock`) |
| `AI_MODEL` | Model ID (default: `minimax.minimax-m2.5`) |
| `AWS_BEARER_TOKEN_BEDROCK` | AWS bearer token for Bedrock |
| `AWS_REGION` | AWS region (default: `us-east-1`) |
| `MOCK_AI` | Enable mock AI mode for testing |

## CI/CD

No CI/CD defined. Use `pnpm test` for E2E testing, `pnpm deploy:prod` for production deployment.

## Testing

- `pnpm test` - Run remote E2E tests (deploys test worker, runs tests, tears down)
- `pnpm test -- --keep-alive` - Keep test worker after tests
- `pnpm cli` - Launch TUI for local development

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

# Run E2E tests
pnpm test

# Deploy to production
pnpm deploy:prod
```
