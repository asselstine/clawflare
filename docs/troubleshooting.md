# Troubleshooting

Common issues and solutions.

## CLI Issues

### "Not logged in. Run 'clawflare login' to authenticate."

**Cause:** CLI token not stored locally.

**Solution:**
```bash
clawflare login
```

Or for self-hosted:
```bash
clawflare open --server <url> --token <token>
```

### "Authentication failed"

**Cause:** Token is invalid or expired.

**Solution:**
```bash
# Re-authenticate
clawflare logout
clawflare login
```

### "Could not connect to server"

**Cause:** Server URL is incorrect or server is down.

**Solution:**
```bash
# Check server URL
clawflare whoami

# For self-hosted, verify the Worker is deployed
curl https://your-worker.workers.dev/health
```

## Server Issues (Self-Hosted)

### "No D1 database found"

**Cause:** Database not created or ID incorrect.

**Solution:**
```bash
cd packages/server

# Create database
wrangler d1 create clawflare

# Update wrangler.jsonc with the database_id
```

### "Migrations failed"

**Cause:** Migration conflict or pending migrations.

**Solution:**
```bash
cd packages/server

# Check migration status
wrangler d1 migrations list clawflare

# Apply pending migrations
wrangler d1 migrations apply clawflare --remote
```

### "Worker deployment failed"

**Check:**
1. Cloudflare API token has correct permissions:
   - Account: Workers Scripts:Edit
   - Account: D1:Edit
   - Account: Account Settings:Read

2. Required secrets are set:
```bash
wrangler secret list
```

3. TypeScript builds:
```bash
pnpm typecheck
```

### "AI provider error"

**Cause:** Missing API key for chosen provider.

**Solution:**
```bash
cd packages/server

# Set provider key
wrangler secret put AWS_BEARER_TOKEN_BEDROCK
# or
wrangler secret put ANTHROPIC_API_KEY
# or
wrangler secret put OPENAI_API_KEY
```

## Local Development Issues

### "wrangler dev fails"

**Cause:** Port conflict or missing local D1.

**Solution:**
```bash
# Use different port
wrangler dev --port 8788

# Check for port conflicts
lsof -i :8787
```

### "Local D1 not found"

```bash
cd packages/server

# Apply local migrations
pnpm db:migrations:apply:local
```

## Container Issues

### "Container not available"

**Cause:** Cloudflare Containers not enabled on account.

**Solution:**
Containers require an opt-in. Check your Cloudflare account settings or contact support.

## Performance Issues

### Slow responses

**Check:**
1. AI provider latency - try Workers AI for fastest response
2. Cold start - first request after deploy is slower
3. Container warmup - container tools have initial delay

**Optimize:**
```bash
# Use faster model
AI_PROVIDER=cloudflare-workers-ai
AI_MODEL=@cf/meta/llama-3.1-8b-instruct
```

## Debugging

### Check Worker logs

```bash
cd packages/server

# Stream logs
pnpm logs

# Or with Wrangler
wrangler tail
```

### Test server health

```bash
curl https://your-worker.workers.dev/health
```

### Check environment variables

```bash
cd packages/server

# List secrets
wrangler secret list
```

## Getting Help

1. Check server logs:
```bash
pnpm logs
```

2. Verify configuration:
```bash
wrangler d1 migrations list clawflare
wrangler secret list
```

3. Test connectivity:
```bash
curl https://your-worker.workers.dev/health
curl https://your-worker.workers.dev/v1/tools -H "Authorization: Bearer <token>"
```

## Common Error Messages

| Error | Likely Cause | Solution |
|-------|-------------|----------|
| `auth failed` | Wrong CLAWFLARE_API_TOKEN | Run `clawflare login` |
| `no provider` | Missing AI API key | Set provider secret |
| `database error` | D1 not migrated | Run migrations |
| `worker not found` | Deploy failed | Check wrangler logs |
| `egress denied` | No handler for domain | Check egress configuration |
| `container error` | Containers not enabled | Contact Cloudflare |
| `timeout` | Slow AI provider | Change provider/model |
