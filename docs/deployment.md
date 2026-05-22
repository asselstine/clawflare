# Deployment Guide

Deploy your Clawflare agent to Cloudflare Workers.

## Quick Deploy

```bash
# One command deploy
clawflare deploy
```

This handles everything:
- Cloudflare authentication
- D1 database creation
- Migration application
- Secret setup
- Worker deployment

## Prerequisites

### 1. Cloudflare Account

Sign up at [cloudflare.com](https://cloudflare.com)

### 2. API Token

Create a token with these permissions:
- Account: Workers Scripts:Edit
- Account: D1:Edit
- Account: Account Settings:Read

```bash
# Set token
export CLOUDFLARE_API_TOKEN=your-token
```

### 3. Authenticate Wrangler

```bash
npx wrangler login
```

Or use API token only:
```bash
export CLOUDFLARE_API_TOKEN=xxx
```

## Deployment Flow

```
Validate config
  ↓
Resolve Cloudflare account
  ↓
Create/reuse D1 database
  ↓
Generate wrangler.jsonc
  ↓
Apply D1 migrations
  ↓
Set secrets
  ↓
Deploy Worker
  ↓
Save deployment URL
```

## First Deployment

```bash
# Create project
clawflare init my-agent
cd my-agent

# Install dependencies
npm install

# Deploy
clawflare deploy
```

You'll be prompted for:
- AI provider API keys (unless already set)
- Confirmation of Cloudflare account

## Subsequent Deployments

```bash
# Deploy updates
clawflare deploy

# Deploy to production environment
clawflare deploy --env production

# Dry run
clawflare deploy --dry-run
```

## Multiple Environments

### Setup Production

```typescript
// clawflare.config.ts
export default defineClawflareConfig({
  name: "my-agent",
  cloudflare: {
    workerName: "my-agent-prod"
  }
});
```

```bash
clawflare deploy --env production
```

### Setup Staging

```typescript
// clawflare.config.ts
export default defineClawflareConfig({
  name: "my-agent",
  cloudflare: {
    workerName: "my-agent-staging"
  }
});
```

```bash
clawflare deploy --env staging
```

## Secret Management

### Set Secret

```bash
clawflare secret set ANTHROPIC_API_KEY
# Enter value when prompted
```

### List Secrets

```bash
clawflare secret list
```

### Environment Variables

```bash
# Read from env var
export ANTHROPIC_API_KEY=sk-xxx
clawflare deploy
```

### .env File

```bash
# .env file
cp .env.example .env
# Edit .env
clawflare deploy
```

## Custom Domains

### Add Custom Domain

```typescript
// clawflare.config.ts
export default defineClawflareConfig({
  name: "my-agent",
  cloudflare: {
    routes: ["agent.example.com/*"]
  }
});
```

Requires:
- Domain on Cloudflare
- DNS record pointing to Worker

### Workers.dev Subdomain

Default URLs:
```
https://my-agent.your-account.workers.dev
```

## Monitoring

### Check Status

```bash
clawflare status
```

Output:
```
Project: my-agent
Worker: my-agent
Account: example-account
Database: my-agent
URL: https://my-agent.workers.dev
Last deploy: 2026-05-21T00:00:00.000Z
```

### View Logs

```bash
# Stream logs
clawflare logs

# Last 100 lines
clawflare logs --tail 100
```

### Health Check

```bash
curl https://my-agent.workers.dev/health
```

## Rollback

### View Versions

```bash
npx wrangler versions list
```

### Deploy Previous Version

```bash
npx wrangler rollback
```

## Troubleshooting

### Deploy Failed

```bash
# Check auth
clawflare doctor

# Verbose output
clawflare deploy --verbose

# Check generated config
clawflare config print
```

### Database Issues

```bash
# List databases
npx wrangler d1 list

# Check migrations
npx wrangler d1 migrations list my-agent

# Apply manually
npx wrangler d1 migrations apply my-agent --remote
```

### Resource Limits

Check your [Cloudflare plan limits](https://developers.cloudflare.com/workers/platform/limits/):
- D1 databases
- Worker invocations
- KV storage
- Durable Objects

## CI/CD Deployment

### GitHub Actions

```yaml
# .github/workflows/deploy.yml
name: Deploy

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v2
        with:
          version: 9
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: pnpm install
      - run: pnpm build
      - run: pnpm exec clawflare deploy
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLAWFLARE_API_TOKEN: ${{ secrets.CLAWFLARE_API_TOKEN }}
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

## Security

- API tokens are encrypted at rest
- D1 databases are isolated per project
- Worker code runs in sandboxed environment
- Egress handlers control outbound HTTP

## Cleanup

### Delete Worker

```bash
npx wrangler delete my-agent
```

### Delete Database

```bash
npx wrangler d1 delete my-agent
```

⚠️ **Warning:** This deletes all session data permanently.