# Clawflare Architecture

This document explains the de-packaging decision and the current architecture.

## De-Packaging Decision

Clawflare previously supported a "packaged project" model where users would:

```bash
clawflare init my-agent
cd my-agent
clawflare deploy
```

This approach has been **rejected**. The new model is:

**Hosted Clawflare as the primary product path.**

### What Changed

| Old Model | New Model |
|-----------|-----------|
| CLI generates per-user projects | CLI is just an API client |
| Users deploy their own Workers | Maintainers deploy the server |
| `clawflare init` creates projects | `clawflare login` authenticates with hosted service |
| `clawflare deploy` deploys Workers | `pnpm deploy` uses Wrangler directly |
| Generated Wrangler config | Checked-in `wrangler.jsonc` |
| Public config API (`defineClawflareConfig`) | Internal server wiring |
| npm-published server packages | Server deployed from repo |

### Why?

1. **Simplicity**: One hosted service is simpler than N user deployments
2. **Multi-tenancy**: Workspace-scoped data is easier with one server
3. **Maintenance**: Updating one server vs. N user projects
4. **True serverless**: Users don't manage infrastructure

### What Remains

Users can still self-host by:

1. Cloning the repository
2. Running `pnpm dev` / `pnpm deploy`
3. Using Wrangler directly

## Current Architecture

### Components

```
┌─────────────────────────────────────────────────────────────┐
│                      Clients                                │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐    │
│  │   CLI    │  │   Web    │  │  Mobile  │  │ Extension│    │
│  │  (TUI)   │  │ (future) │  │ (future) │  │ (future) │    │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘    │
└───────┼─────────────┼─────────────┼─────────────┼──────────┘
        │             │             │             │
        └─────────────┴─────────────┴─────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                 Clawflare Server (Worker)                   │
│                                                             │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐   │
│  │ HTTP Routes │  │  WebSocket  │  │  Cloudflare         │   │
│  │  /v1/chat   │  │   /ws       │  │  Workflow           │   │
│  │  /v1/tools  │  │             │  │  (PersistentSession)│   │
│  │  /v1/auth   │  │             │  │                     │   │
│  └──────┬──────┘  └──────┬──────┘  └─────────────────────┘   │
│         │                │                                   │
│         └────────────────┼──────────────────┐                │
│                          │                  │                │
│  ┌───────────────────────▼──────────────────▼─────────────┐  │
│  │              Durable Objects                          │  │
│  │  ┌─────────────────┐  ┌─────────────────────────────┐ │  │
│  │  │ClawflareSession │  │ClawflareSessionCoordinator  │ │  │
│  │  │WebSocket Session│  │ (queue/event serialization)  │ │  │
│  │  └─────────────────┘  └─────────────────────────────┘ │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                             │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                        D1 Database                          │
│                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │   sessions   │  │    users     │  │  workspaces  │      │
│  │ session_events│ │   cli_tokens │  │memberships   │      │
│  │ stored_code  │  │ oauth_accounts│                │      │
│  └──────────────┘  └──────────────┘  └──────────────┘      │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Key Design Decisions

**1. CLI is a client, not a deployment tool**

The CLI authenticates with the Clawflare API and launches the TUI. It does not:
- Create projects
- Deploy Workers
- Manage Cloudflare resources
- Generate Wrangler config

**2. Server is the product**

The server implementation in `packages/server` is the primary deliverable. It is deployed by maintainers using Wrangler directly, not through the CLI.

**3. Workspace-scoped data**

All user data belongs to a workspace:
- Sessions
- Stored code
- Egress handlers
- Session events

Cross-workspace access is prevented at the repository level.

**4. Wrangler is the deployment interface**

Server deployment uses Wrangler directly:

```bash
wrangler dev
wrangler deploy
wrangler d1 migrations apply
```

Root scripts provide convenience:

```bash
pnpm dev      # → wrangler dev
pnpm deploy   # → wrangler deploy
pnpm logs     # → wrangler tail
```

**5. No public config API**

Removed:
- `defineClawflareConfig()`
- `createClawflareWorker()`
- Config-driven plugin registration

Server wiring is direct and explicit:

```typescript
// Instead of config-driven:
const registry = createEgressRegistryWithConfig(config)

// Direct wiring:
const registry = new EgressRegistry();
registerGithub(registry);
registerCloudflare(registry);
```

## Data Flow

### Chat Session

```
1. User sends message via TUI
2. CLI POST /v1/chat with sessionId
3. Server enqueues message in D1 input_queue
4. Workflow wakes, dequeues message
5. Workflow loads session context from D1
6. Workflow calls AI provider
7. Tool calls execute (workspace-scoped)
8. Response stored in D1 session_events
9. Response streamed to CLI
```

### WebSocket Session

```
1. CLI upgrades to WebSocket on /ws
2. ClawflareWebSocketSession DO created
3. User prompts sent via WebSocket
4. DO creates/wakes Workflow for session
5. Workflow processes as above
6. Final assistant message pushed via WebSocket
```

### Container Workspace

```
1. User calls container_create tool
2. Server provisions CodingContainer
3. Container runs container-runtime/server.mjs
4. Tool calls proxied to container HTTP server
5. Container has: bash, git, ripgrep, node
```

## Authentication

### Hosted Path

```
clawflare login
  → Server prints OAuth URL
  → User authenticates with GitHub
  → Server issues CLI token
  → Token stored in OS config dir
  → CLI uses token for API calls
```

### Self-Hosted Path

```
clawflare open --server <url> --token <token>
  → CLI connects directly
  → Token validated by server
  → Session created in specified workspace
```

## API Endpoints

| Endpoint | Auth | Description |
|----------|------|-------------|
| `POST /v1/auth/login` | No | Start OAuth flow or CLI password login |
| `GET /v1/me` | Yes | Get current user info |
| `GET /v1/workspaces` | Yes | List user's workspaces |
| `POST /v1/chat` | Yes | Start/resume D1-backed workflow session |
| `GET /v1/session/:id` | Yes | Poll session messages/events |
| `POST /v1/session/:id/close` | Yes | Mark session closed |
| `GET /v1/tools` | Yes | List available tools |
| `WS /ws` | Yes | WebSocket for real-time sessions |

## Integration Points

### AI Provider

```typescript
// @earendil-works/pi-ai
const provider = createAIProvider({
  provider: "amazon-bedrock",
  model: "minimax.minimax-m2.5"
});
```

### Egress Handlers

```typescript
// Server-owned, not user-authored
const registry = new EgressRegistry();
registerGithub(registry);      // api.github.com
registerCloudflare(registry);  // api.cloudflare.com
```

### Container Runtime

```
container-runtime/
  Dockerfile          # Debian + git + ripgrep
  server.mjs          # HTTP server for tool execution
```

## Testing

- **Unit tests**: Per-package with Vitest
- **E2E tests**: Deploys temporary Worker + D1, runs full API tests, tears down

```bash
pnpm --filter @clawflare/server test  # Unit tests
pnpm test:e2e                          # Remote E2E tests
```

## Future Directions

Possible extensions:
- Web UI
- More AI providers
- Additional egress handlers
- Container workspace customization

Not planned:
- User-authored bundled tools
- Plugin marketplace
- Per-user Worker deployment
- Generated project scaffolding
