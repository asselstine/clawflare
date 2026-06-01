# Clawflare - Agent Onboarding Guide

## Project Overview

**Clawflare** is an AI agent harness that runs on Cloudflare Workers, providing a durable, multi-turn agent execution environment with tool support. D1 is the source of truth for persisted sessions, events, input queues, runtime state, stored code, and egress handler metadata.

## Package Structure

### 1. `packages/server/` - Core Cloudflare Worker

A Typescript Hono-based server that acts as the cloud harness for clients.

### 2. `packages/cli/` - TUI Client

The CLI is an **API client**, not a deployment tool. It connects to a hosted Clawflare server or self-hosted instance.

## CI/CD

No CI/CD defined. Use `pnpm typecheck`, `pnpm --filter @clawflare/server test`, `pnpm build`, and `pnpm test` for validation; use `pnpm deploy:prod` for production deployment.

## Testing

- `pnpm --filter @clawflare/server test` - Run harness unit tests, including D1 migration/repository concurrency tests
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
pnpm --filter @clawflare/server test

# Run E2E tests
pnpm test

# Apply local D1 migrations
pnpm --filter @clawflare/server db:migrations:apply:local

# Apply remote D1 migrations
pnpm --filter @clawflare/server db:migrations:apply:remote

# Deploy to production
pnpm deploy:prod
```
