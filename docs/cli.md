# Clawflare CLI Reference

The `clawflare` command-line tool manages the complete lifecycle of your AI agent.

## Global Installation

```bash
npm install -g clawflare
```

## Commands

### `clawflare init <name>`

Create a new Clawflare project.

```bash
clawflare init my-agent
clawflare init my-agent --template github
clawflare init my-agent --template cloudflare
clawflare init my-agent --template full
clawflare init my-agent --no-install
```

**Options:**
- `--template <name>` - Template to use (`minimal`, `github`, `cloudflare`, `full`)
- `--provider <name>` - AI provider (anthropic, openai, bedrock)
- `--no-install` - Skip dependency installation
- `--package-manager <pm>` - Use npm, pnpm, or yarn

**Generated files:**
```
my-agent/
  package.json
  clawflare.config.ts
  src/
    index.ts
    tools.ts
    egress.ts
  migrations/
  .env.example
  .gitignore
  .clawflare/
    state.json
    wrangler.jsonc (generated)
```

---

### `clawflare deploy`

Deploy your agent to Cloudflare.

```bash
clawflare deploy
clawflare deploy --env production
clawflare deploy --print-config
```

**What it does:**
1. Validates project configuration
2. Detects Cloudflare account
3. Creates or reuses D1 database
4. Generates `wrangler.jsonc`
5. Applies D1 migrations
6. Sets required secrets
7. Deploys the Worker
8. Saves deployment URL

**Options:**
- `--env <name>` - Deploy to environment (production, staging)
- `--print-config` - Print generated Wrangler config without deploying
- `--force-secrets` - Force re-prompt for secrets
- `--dry-run` - Validate but don't deploy

---

### `clawflare open`

Open the TUI to interact with your deployed agent.

```bash
# Auto-detect from deployment state
clawflare open

# Manual connection
clawflare open --host https://my-agent.workers.dev --token <api-token>

# Connect to local dev
clawflare open --local
```

**Options:**
- `--host <url>` - Harness URL
- `--token <token>` - API token
- `--local` - Connect to local dev server

---

### `clawflare dev`

Run local development server.

```bash
clawflare dev
clawflare dev --port 8787
```

Starts Wrangler dev server with local D1.

---

### `clawflare status`

Show deployment status.

```bash
clawflare status
```

**Output:**
```
Project: my-agent
Worker: my-agent
Account: example-account
Database: my-agent (ID: xxx...)
URL: https://my-agent.workers.dev
Last deploy: 2026-05-21T00:00:00.000Z
```

---

### `clawflare doctor`

Diagnose project health.

```bash
clawflare doctor
```

**Checks:**
- ✓ Node version
- ✓ Dependencies installed
- ✓ Project config valid
- ✓ Wrangler available
- ✓ Cloudflare auth configured
- ✓ D1 database exists
- ✓ Migrations applied
- ✓ Worker reachable

---

### `clawflare logs`

Stream Worker logs.

```bash
clawflare logs
clawflare logs --tail 100
```

---

### `clawflare secret set <name>`

Set a secret.

```bash
clawflare secret set ANTHROPIC_API_KEY
clawflare secret set OPENAI_API_KEY
```

---

### `clawflare upgrade`

Upgrade project to latest Clawflare version.

```bash
clawflare upgrade
clawflare upgrade --dry-run
```

---

## Environment Variables

The CLI respects these environment variables:

| Variable | Description |
|----------|-------------|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API token |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID |
| `AI_PROVIDER` | Default AI provider |
| `AI_MODEL` | Default AI model |

## Project State

Deployment state is stored in `.clawflare/state.json`:

```json
{
  "version": 1,
  "projectName": "my-agent",
  "cloudflare": {
    "accountId": "...",
    "workerName": "my-agent",
    "d1DatabaseId": "..."
  },
  "deployment": {
    "url": "https://...",
    "lastDeployedAt": "..."
  }
}
```

This file is machine-specific and should be gitignored.
