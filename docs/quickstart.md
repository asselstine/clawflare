# Clawflare Quickstart

Get up and running with Clawflare.

## Hosted Clawflare (Recommended)

### 1. Install the CLI

```bash
npm install -g clawflare
```

### 2. Login

```bash
clawflare login
```

This will:
- Print a URL to open in your browser
- Authenticate via OAuth
- Store your credentials locally

### 3. Open the TUI

```bash
clawflare open
```

Start chatting with your AI agent!

## Self-Hosted Clawflare

For self-hosting, you'll work with the repository directly.

### Prerequisites

- Node.js 22+
- pnpm 9+
- Cloudflare account with API token

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
# Edit .env with your credentials
```

### 4. Run Local Development

```bash
# Start the dev server
pnpm dev

# Apply database migrations
pnpm --filter @clawflare/server db:migrations:apply:local
```

### 5. Deploy

```bash
# Apply migrations to remote D1
pnpm --filter @clawflare/server db:migrations:apply:remote

# Deploy the Worker
pnpm deploy
```

### 6. Connect with CLI

```bash
# Connect to your self-hosted instance
clawflare open --server https://your-worker.workers.dev --token <your-token>
```

## Next Steps

- [CLI Reference](./cli.md) - Learn all CLI commands
- [Self-Hosting Guide](./self-hosting.md) - Detailed self-host instructions
- [Architecture](./architecture.md) - Understand how Clawflare works
