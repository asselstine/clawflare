# Troubleshooting

Common issues and solutions.

## Installation Issues

### Global install fails

```bash
# Try with explicit permission
sudo npm install -g clawflare

# Or use pnpm
pnpm add -g clawflare

# Or use npx (no install needed)
npx clawflare init my-agent
```

## Deployment Issues

### "No Cloudflare account found"

**Cause:** Wrangler not authenticated.

**Solution:**
```bash
# Login to Cloudflare
npx wrangler login

# Or use API token
export CLOUDFLARE_API_TOKEN=your-token
```

### "D1 database already exists"

**Cause:** Database name conflicts with existing database.

**Solution:**
```bash
# Option 1: Use different project name
clawflare init my-agent-2

# Option 2: Reuse existing database
# Edit .clawflare/state.json and set d1DatabaseId
```

### "Migrations failed"

**Cause:** Migration already applied or schema conflict.

**Solution:**
```bash
# Check migration status
npx wrangler d1 migrations list <database>

# Force apply (careful!)
npx wrangler d1 migrations apply <database> --remote
```

### "Worker deployment failed"

**Check:**
1. Cloudflare API token has correct permissions:
   - Account: Workers Scripts:Edit
   - Account: D1:Edit
   - Account: Account Settings:Read

2. Worker name is unique:
```bash
# Check existing workers
npx wrangler whoami
```

3. Dependencies are built:
```bash
pnpm build
```

## Runtime Issues

### "API authentication failed"

**Cause:** Missing or incorrect CLAWFLARE_API_TOKEN.

**Solution:**
```bash
# Check token
clawflare doctor

# Regenerate token (in your .env)
CLAWFLARE_API_TOKEN=$(openssl rand -hex 32)
clawflare secret set CLAWFLARE_API_TOKEN
```

### "AI provider error"

**Cause:** Missing API key for chosen provider.

**Solution:**
```bash
# Set provider-specific key
clawflare secret set ANTHROPIC_API_KEY
# or
clawflare secret set OPENAI_API_KEY
# or
clawflare secret set AWS_BEARER_TOKEN_BEDROCK
```

### "Container not available"

**Cause:** Cloudflare Containers not enabled on account.

**Solution:**
Containers require an opt-in. Check your Cloudflare account settings or contact support.

Workaround without containers:
```typescript
// Disable container tools
export default defineClawflareConfig({
  name: "my-agent",
  // Container tools auto-enabled if available
  // Use built-in tools instead
});
```

## Local Development Issues

### "wrangler dev fails"

**Cause:** Port conflict or missing local D1.

**Solution:**
```bash
# Use different port
clawflare dev --port 8788

# Or check for port conflicts
lsof -i :8787
```

### "Local D1 not found"

```bash
# Initialize local D1
npx wrangler d1 create clawflare-local --local

# Or generate config again
clawflare config generate
```

## Performance Issues

### Slow responses

**Check:**
1. AI provider latency - try Workers AI for fastest response
2. Cold start - first request after deploy is slower
3. Container warmup - container tools have initial delay

**Optimize:**
```typescript
// Use faster model
ai: {
  provider: "cloudflare-workers-ai",
  model: "@cf/meta/llama-3.1-8b-instruct"
}
```

### High memory usage

**Cause:** Large stored code or many sessions.

**Solution:**
```bash
# Clean up old sessions
npx wrangler d1 execute <database> --remote --command "DELETE FROM sessions WHERE status = 'closed' AND updated_at < datetime('now', '-7 days');"
```

## Debugging

### Enable verbose logging

```bash
# CLI verbose mode
clawflare deploy --verbose
clawflare doctor --verbose
```

### Check Worker logs

```bash
# Stream logs
clawflare logs

# Or with Wrangler
npx wrangler tail
```

### Inspect generated config

```bash
# Print wrangler.jsonc
clawflare config print

# Save to file
clawflare config print > wrangler-debug.jsonc
```

### Test ingress locally

```bash
# Start dev server
clawflare dev &

# Test endpoint
curl http://localhost:8787/health
```

## Getting Help

1. Run diagnostics:
```bash
clawflare doctor
```

2. Check status:
```bash
clawflare status
```

3. Review logs:
```bash
clawflare logs --tail 50
```

4. Check configuration:
```bash
clawflare config print
```

## Common Error Messages

| Error | Likely Cause | Solution |
|-------|-------------|----------|
| `auth failed` | Wrong CLAWFLARE_API_TOKEN | Check .env, redeploy secrets |
| `no provider` | Missing AI API key | Set provider secret |
| `database error` | D1 not created/migrated | Run migrations |
| `worker not found` | Deploy failed | Check wrangler logs |
| `egress denied` | No handler for domain | Add egress handler |
| `container error` | Containers not enabled | Contact Cloudflare or disable |
| `timeout` | Slow AI provider | Change provider or model |