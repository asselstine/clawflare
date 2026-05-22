# Container Tools Implementation

This document describes the container workspace capability implemented for the Clawflare agent harness.

## Overview

The container tools provide a first-class isolated development environment for the Clawflare agent. Agents can create containers, run shell commands, and perform filesystem operations - all within a secure, isolated sandbox.

## Architecture

### Components

1. **Container Runtime** (`container-runtime/`)
   - `Dockerfile` - Debian-based image with Node.js, git, ripgrep, and dev tools
   - `server.mjs` - HTTP server providing command and file operation endpoints

2. **Container Class** (`src/container/coding-container.ts`)
   - `CodingContainer` - Cloudflare Container subclass
   - Routes egress through Clawflare's egress gateway
   - MITM HTTPS interception for HTTPS egress control

3. **Container Client** (`src/container/client.ts`)
   - Worker-side RPC client for the container runtime
   - Functions for all container operations

4. **Container Tools** (`src/container/tools.ts`)
   - Model-visible tool factories
   - 8 tools: `container_create`, `container_bash`, `container_read`, `container_write`, `container_edit`, `container_grep`, `container_find`, `container_ls`

5. **Utilities** (`src/container/`)
   - `ids.ts` - Container ID validation and generation
   - `paths.ts` - Path validation and workspace boundary checks
   - `output.ts` - Output truncation helpers

### Tool Surface

| Tool | Purpose |
|------|---------|
| `container_create` | Create/initialize a persistent coding container |
| `container_bash` | Execute shell commands in workspace |
| `container_read` | Read text files with optional line ranges |
| `container_write` | Write or append to files |
| `container_edit` | Surgical file edits with exact string replacement |
| `container_grep` | Search file contents (uses ripgrep) |
| `container_find` | Find files/directories by pattern |
| `container_ls` | List directory contents |

### Security Controls

- All operations confined to `/workspace`
- Path traversal prevention with normalized path checking
- No raw secrets in container environment
- Egress routed through Clawflare's egress gateway
- MITM HTTPS allows safe HTTPS git operations
- Bounded command timeouts (default 30s, max 30min)
- Bounded output size (default 8KB, max 1MB)

### Configuration

Added to `wrangler.jsonc`:

```json
{
  "containers": [
    {
      "class_name": "CodingContainer",
      "image": "./container-runtime/Dockerfile",
      "max_instances": 10,
      "instance_type": "dev"
    }
  ],
  "durable_objects": {
    "bindings": [
      {
        "name": "CODING_CONTAINER",
        "class_name": "CodingContainer"
      }
    ]
  },
  "migrations": [
    {
      "tag": "v4",
      "new_sqlite_classes": ["CodingContainer"]
    }
  ]
}
```

## Container Image

Based on `node:22-bookworm-slim` with:
- bash, ca-certificates, coreutils, findutils
- git, grep, openssh-client, ripgrep
- sed, tar, curl

Entrypoint handles MITM CA certificate installation:
```bash
if [ -f /etc/cloudflare/certs/cloudflare-containers-ca.crt ]; then
  cp /etc/cloudflare/certs/cloudflare-containers-ca.crt /usr/local/share/ca-certificates/cloudflare-containers-ca.crt
  update-ca-certificates
fi
```

## Runtime Server API

The tiny HTTP server inside the container provides:

```text
GET  /health                - Health check
POST /bash                  - Execute command
POST /read                  - Read file
POST /write                 - Write file
POST /edit                  - Edit file (exact string replacement)
POST /grep                  - Search contents
POST /find                  - Find files
POST /ls                    - List directory
```

All requests are issued by trusted Worker code through `containerFetch()`.

## Egress Integration

Container outbound requests are routed through `routeOutboundRequest()`:

```typescript
CodingContainer.outbound = async (request, env, ctx) => {
  const requestId = ctx?.containerId ? `container:${ctx.containerId}` : "container:unknown";
  return routeOutboundRequest(env, request, requestId);
};
```

This ensures containers share the same egress policy as Dynamic Workers:
- Domain-specific egress handlers
- Optional credential injection
- Allow/deny per-host policy
- Comprehensive request logging

## Session-scoped Containers

By default, each session gets a container ID derived from the session ID:

```typescript
const containerId = `session-${sanitizedSessionId}`;
```

All tools accept an optional `containerId` to use a specific container:
- `undefined` - Uses session's default container
- Explicit ID - Uses that specific container

## Usage Example

Agent interactions:

```
User: Create a scratch workspace and write a note

Agent: 
1. Calls container_create
2. Container starts with an empty /workspace
3. Calls container_write path="note.txt"
4. Returns confirmation to user
```

## Testing

Unit tests should cover:
- Container ID validation (`^[-_a-zA-Z0-9]{1,64}$`)
- Path normalization and workspace escape prevention
- Output truncation logic
- Edit behavior (zero/many match errors)

E2E tests (in `packages/e2e`) cover:
- Container lifecycle
- All file operations
- Git clone over HTTPS
- Egress routing

## Future Enhancements

Potential phase-two features:
- Multiple container images via class selection
- Snapshot/persistence of container filesystem
- Container-to-container networking
- Arbitrary standard images with injected entrypoint
