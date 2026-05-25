# Clawflare CLI Reference

The `clawflare` command-line tool is a client for the Clawflare hosted service.

## Global Installation

```bash
npm install -g clawflare
```

## Commands

### `clawflare login`

Authenticate with the Clawflare server.

```bash
clawflare login
clawflare login --server https://app.clawflare.dev
clawflare login --server http://localhost:8787
```

**Options:**
- `--server <url>` - Clawflare server URL (default: https://app.clawflare.dev)

**Behavior:**
1. Prints a URL to open in your browser
2. Authenticates via OAuth (GitHub)
3. Stores token locally in OS config directory:
   - macOS: `~/Library/Application Support/clawflare/config.json`
   - Linux: `~/.config/clawflare/config.json`
   - Windows: `%APPDATA%\clawflare\config.json`

---

### `clawflare logout`

Remove stored authentication.

```bash
clawflare logout
```

**Behavior:**
- Deletes local token
- Clears cached server/workspace selection
- Attempts server-side token revocation

---

### `clawflare whoami`

Show current authentication status.

```bash
clawflare whoami
```

**Output:**
```
Server: https://app.clawflare.dev
User: brendan
Workspace: personal
```

---

### `clawflare open`

Open the TUI for your agent.

```bash
# Connect to hosted service (default)
clawflare open

# Connect to self-hosted server
clawflare open --server https://my-server.workers.dev --token <api-token>

# Specify workspace
clawflare open --workspace <workspace-id>
```

**Options:**
- `--server <url>` - Clawflare server URL
- `--token <token>` - API token for authentication
- `--workspace <id>` - Workspace to use

**Token Priority:**
1. `--token` option
2. `CLAWFLARE_API_TOKEN` environment variable
3. Saved config from `clawflare login`

**Server Priority:**
1. `--server` option
2. `CLAWFLARE_URL` environment variable
3. Saved config from `clawflare login`
4. Default: https://app.clawflare.dev

---

## Environment Variables

| Variable | Description |
|----------|-------------|
| `CLAWFLARE_URL` | Clawflare server URL |
| `CLAWFLARE_API_TOKEN` | API token for authentication |
| `CLAWFLARE_WORKSPACE` | Default workspace ID |

## Local Storage

Authentication is stored in OS-level config directories (not project-local):

- **macOS**: `~/Library/Application Support/clawflare/config.json`
- **Linux**: `~/.config/clawflare/config.json`
- **Windows**: `%APPDATA%\clawflare\config.json`

Example config:
```json
{
  "server": "https://app.clawflare.dev",
  "token": "clf_xxxxxxxxxxxx"
}
```
