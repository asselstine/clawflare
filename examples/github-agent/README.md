# GitHub Agent Example

A Clawflare agent with GitHub integration.

## Features

- GitHub API access via `@clawflare/github` plugin
- Repository browsing
- Issue/PR management
- File content access

## Setup

```bash
# Copy example
cp -r examples/github-agent my-agent
cd my-agent

# Install dependencies
npm install

# Set GitHub token
clawflare secret set GITHUB_TOKEN

# Deploy
clawflare deploy

# Open TUI
clawflare open
```

## Configuration

```typescript
import { github } from "@clawflare/github";

export default defineClawflareConfig({
  name: "github-agent",
  plugins: [github()],
  ai: {
    provider: "anthropic",
    model: "claude-3-5-sonnet-20241022"
  }
});
```

## Usage

Ask the agent about GitHub:
- "List my repositories"
- "Show open issues in owner/repo"
- "Get the README from owner/repo"
- "Find PRs waiting for review"