# Clawflare Web

A static web client for the Clawflare agent harness. It provides a browser-based chat interface with session management, model/provider configuration, egress handler management, tool inspection, and debug access against a hosted or self-hosted Clawflare API.

The app is built with Vite, React, TypeScript, TanStack Query, Tailwind CSS, and Zod.

## Usage

Start the development server:

```bash
pnpm --filter @clawflare/web dev
```

Open the local URL printed by Vite, usually:

```text
http://localhost:5173/
```

The default Clawflare API endpoint matches the CLI:

```text
https://clawflare-runtime.brendan-410.workers.dev
```

In the Settings panel, click **Login with GitHub**. The app starts the same device authorization flow as the CLI:

1. The app asks the Clawflare API to start GitHub OAuth.
2. GitHub opens in a new window.
3. After approval, the web app polls the API, receives the access token, shows `Approved!`, stores the token in local storage, and returns you to the app.

You can also configure the connection manually:

- `Server URL`: your Clawflare API endpoint
- `API token`: a bearer token accepted by that server

The values are stored in browser local storage and sent directly from the browser to the Clawflare API.

## Features

- Chat interface with streaming session updates and polling fallback
- Session list, open, rename, fork, kill, and clear workflows
- Slash commands matching the TUI surface:
  - `/new`
  - `/fork`
  - `/sessions [status]`
  - `/open [session-id]`
  - `/kill [session-id|all]`
  - `/name <name>`
  - `/tools`
  - `/models`
  - `/cf_debug [key]`
  - `/clear`
  - `/help`
- Model connection setup and default model selection
- Egress handler configuration, enable/disable, and deletion
- Tool definition browser
- `cf_debug` panel for session storage inspection

## Development

Install dependencies from the workspace root:

```bash
pnpm install
```

Run the web app:

```bash
pnpm --filter @clawflare/web dev
```

Typecheck the package:

```bash
pnpm --filter @clawflare/web typecheck
```

Build the static app:

```bash
pnpm --filter @clawflare/web build
```

Preview the production build:

```bash
pnpm --filter @clawflare/web preview
```

Run the full workspace typecheck:

```bash
pnpm typecheck
```
