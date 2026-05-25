# Self-Hosting Clawflare

This guide covers running your own Clawflare server on Cloudflare Workers.

## Prerequisites

- Node.js 22+
- pnpm 9+
- Cloudflare account with:
  - Workers Scripts:Edit permission
  - D1:Edit permission
  - Account Settings:Read permission

## Setup

### 1. Clone the Repository

```bash
git clone https://github.com/asselstine/clawflare
cd clawflare
```

### 2. Install Dependencies

```bash
pnpm install
```

### 3. Configure Environment

```bash
cp packages/server/.env.example packages/server/.env
```

Edit `packages/server/.env`:

```bash
# Required: Cloudflare API token
CF_API_TOKEN=your_cloudflare_api_token

# Required: Clawflare API token (for self-hosted auth)
CLAWFLARE_API_TOKEN=$(openssl rand -hex 32)

# Required: AI provider credentials
# Choose one:
AWS_BEARER_TOKEN_BEDROCK=your_aws_token
ANTHROPIC_API_KEY=your_anthropic_key
# or OPENAI_API_KEY=your_openai_key

# Optional: GitHub OAuth (for CLI login)
GITHUB_CLIENT_ID=your_github_app_client_id
GITHUB_CLIENT_SECRET=your_github_app_client_secret
```

### 4. Run Local Development

```bash
# Start Wrangler dev server
pnpm dev
```

The server runs at `http://localhost:8787`.

### 5. Apply Local Migrations

```bash
# Create local D1 database and apply migrations
pnpm --filter @clawflare/server db:migrations:apply:local
```

### 6. Deploy

```bash
# Apply migrations to remote D1
pnpm --filter @clawflare/server db:migrations:apply:remote

# Deploy the Worker
pnpm deploy
```

## Server Package Scripts

All server operations go through Wrangler:

```bash
# Development
cd packages/server

# Run dev server
pnpm dev

# Deploy to production
pnpm deploy

# View logs
pnpm logs

# Database migrations
pnpm db:migrations:create <name>
pnpm db:migrations:apply:local
pnpm db:migrations:apply:remote
pnpm db:migrations:list

# Type check
pnpm typecheck

# Run tests
pnpm test
```

## Root Package Scripts

Convenience scripts from repository root:

```bash
# Run dev server
pnpm dev

# Deploy
pnpm deploy

# View logs
pnpm logs

# Run all tests
pnpm test

# Run E2E tests
pnpm test:e2e
```

## Cloudflare Resources

The server creates:

- **Worker**: Clawflare API and WebSocket handler
- **D1 Database**: Session storage, events, stored code
- **Durable Object**: Session coordination and WebSocket sessions
- **Workflow**: Persistent session execution

## Configuration

### wrangler.jsonc

Server configuration is in `packages/server/wrangler.jsonc`:

```jsonc
{
  "name": "clawflare-server",
  "main": "src/index.ts",
  "compatibility_date": "2025-05-01",
  "d1_databases": [
    {
      "binding": "CLAWFLARE_DB",
      "database_name": "clawflare",
      "database_id": "your-database-id"
    }
  ],
  // ... other config
}
```

### Environment Variables

Set secrets with Wrangler:

```bash
cd packages/server

# Set a secret
wrangler secret put CLAWFLARE_API_TOKEN
wrangler secret put AWS_BEARER_TOKEN_BEDROCK
```

## Connecting Your CLI

After deploying, connect the CLI to your self-hosted instance:

```bash
clawflare open --server https://your-worker.workers.dev --token <your-token>
```

## Troubleshooting

### "No D1 database found"

```bash
# Create database
wrangler d1 create clawflare

# Update wrangler.jsonc with the database_id
```

### "Migrations failed"

```bash
# Check migrations status
wrangler d1 migrations list clawflare

# Force apply
wrangler d1 migrations apply clawflare --remote
```

### "Worker deployment failed"

Check:
1. Cloudflare API token has correct permissions
2. All required secrets are set
3. TypeScript builds successfully: `pnpm typecheck`

## Security

- Keep `CLAWFLARE_API_TOKEN` secure
- Set up GitHub OAuth for proper CLI authentication
- Use environment-specific D1 databases
- Review egress handler permissions

## Updates

```bash
# Pull latest changes
git pull

# Install any new dependencies
pnpm install

# Apply new migrations
pnpm --filter @clawflare/server db:migrations:apply:remote

# Redeploy
pnpm deploy
```
