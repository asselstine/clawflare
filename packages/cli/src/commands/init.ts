/**
 * Clawflare CLI - init command
 * Creates a new Clawflare project
 */

import * as fs from "fs/promises";
import * as path from "path";

interface InitOptions {
  template?: string;
  packageManager?: "npm" | "pnpm" | "yarn";
  noInstall?: boolean;
  provider?: string;
  model?: string;
}

const MINIMAL_TEMPLATE = {
  "clawflare.config.ts": `import { defineClawflareConfig } from "@clawflare/runtime";

export default defineClawflareConfig({
  name: "{{PROJECT_NAME}}",
  ai: {
    provider: "{{AI_PROVIDER}}",
    model: "{{AI_MODEL}}",
  },
});
`,
  "src/index.ts": `import config from "../clawflare.config";
import { createClawflareWorker } from "@clawflare/runtime";

export default createClawflareWorker(config);
`,
  "src/tools.ts": `import { defineTool } from "@clawflare/runtime";

// Define your custom tools here
// Example:
// export const tools = [
//   defineTool({
//     name: "hello",
//     description: "Say hello",
//     parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
//     execute: async ({ name }) => ({ message: \`Hello, \${name}!\` }),
//   }),
// ];

export const tools = [];
`,
  "src/egress.ts": `import { defineEgressHandler } from "@clawflare/egress-core";

// Define your custom egress handlers here
// Example:
// export const egressHandlers = [
//   defineEgressHandler({
//     name: "example",
//     domains: ["api.example.com"],
//     async handles(request) {
//       return new URL(request.url).hostname === "api.example.com";
//     },
//     async fetch(request, ctx) {
//       return fetch(request);
//     },
//   }),
// ];

export const egressHandlers = [];
`,
  ".env.example": `# Clawflare environment variables
# Copy this file to .env and fill in your values

# API Token for your Clawflare deployment
CLAWFLARE_API_TOKEN=your_token_here

# AI Provider API Keys (depending on your config)
# ANTHROPIC_API_KEY=your_key_here
# AWS_BEARER_TOKEN_BEDROCK=your_token_here
`,
  ".gitignore": `node_modules/
dist/
.env
.dev.vars
.clawflare/state.json
.clawflare/wrangler.jsonc
*.log
`,
};

function getPackageJson(projectName: string): string {
  return JSON.stringify(
    {
      name: projectName,
      version: "0.1.0",
      private: true,
      type: "module",
      scripts: {
        dev: "clawflare dev",
        deploy: "clawflare deploy",
        open: "clawflare open",
        typecheck: "tsc --noEmit",
      },
      dependencies: {
        "@clawflare/runtime": "^0.1.0",
        "@clawflare/egress-core": "^0.1.0",
      },
      devDependencies: {
        typescript: "^5.6.0",
        wrangler: "^4.0.0",
      },
    },
    null,
    2
  );
}

function getTsConfig(): string {
  return JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        lib: ["ES2022"],
        moduleResolution: "bundler",
        resolveJsonModule: true,
        esModuleInterop: true,
        skipLibCheck: true,
        forceConsistentCasingInFileNames: true,
        strict: true,
        noEmit: true,
      },
    },
    null,
    2
  );
}

function getStateJson(): string {
  return JSON.stringify(
    {
      version: 1,
    },
    null,
    2
  );
}

function renderTemplate(template: string, variables: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => variables[key] || "");
}

export async function initCommand(
  projectName: string,
  options: InitOptions
): Promise<void> {
  const cwd = process.cwd();
  const projectDir = path.join(cwd, projectName);

  // Validate project name
  if (!/^[a-z0-9-]+$/.test(projectName)) {
    console.error(
      `Error: Project name "${projectName}" must be lowercase alphanumeric with hyphens only`
    );
    process.exit(1);
  }

  // Check if directory already exists
  try {
    await fs.access(projectDir);
    console.error(`Error: Directory "${projectName}" already exists`);
    process.exit(1);
  } catch {
    // Directory doesn't exist, good
  }

  console.log(`Creating Clawflare project "${projectName}"...`);

  // Create directories
  await fs.mkdir(projectDir, { recursive: true });
  await fs.mkdir(path.join(projectDir, "src"), { recursive: true });
  await fs.mkdir(path.join(projectDir, ".clawflare"), { recursive: true });
  await fs.mkdir(path.join(projectDir, "migrations"), { recursive: true });

  // Template variables
  const variables: Record<string, string> = {
    PROJECT_NAME: projectName,
    AI_PROVIDER: options.provider || "amazon-bedrock",
    AI_MODEL: options.model || "minimax.minimax-m2.5",
  };

  // Write template files
  for (const [filePath, content] of Object.entries(MINIMAL_TEMPLATE)) {
    const fullPath = path.join(projectDir, filePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, renderTemplate(content, variables));
  }

  // Write package.json
  await fs.writeFile(path.join(projectDir, "package.json"), getPackageJson(projectName));

  // Write tsconfig.json
  await fs.writeFile(path.join(projectDir, "tsconfig.json"), getTsConfig());

  // Write state.json
  await fs.writeFile(path.join(projectDir, ".clawflare", "state.json"), getStateJson());

  // Write README
  const readme = `# ${projectName}

A Clawflare agent project.

## Getting Started

1. Configure your environment:
   \`\`\`bash
   cp .env.example .env
   # Edit .env with your API tokens
   \`\`\`

2. Install dependencies:
   \`\`\`bash
   ${options.packageManager || "npm"} install
   \`\`\`

3. Deploy your agent:
   \`\`\`bash
   clawflare deploy
   \`\`\`

4. Open the TUI:
   \`\`\`bash
   clawflare open
   \`\`\`

## Project Structure

- \`clawflare.config.ts\` - Agent configuration
- \`src/tools.ts\` - Custom tools
- \`src/egress.ts\` - Custom egress handlers
- \`migrations/\` - Database migrations
- \`.clawflare/\` - Generated configuration

## Commands

- \`clawflare dev\` - Start local development server
- \`clawflare deploy\` - Deploy to Cloudflare
- \`clawflare open\` - Open the TUI
- \`clawflare doctor\` - Check project health
- \`clawflare status\` - Show deployment status

## Documentation

See https://github.com/earendil-works/clawflare for full documentation.
`;
  await fs.writeFile(path.join(projectDir, "README.md"), readme);

  console.log(`\nCreated ${projectName}/`);
  console.log("\nNext steps:");
  console.log(`  cd ${projectName}`);
  
  if (!options.noInstall) {
    const pm = options.packageManager || "npm";
    console.log(`  ${pm} install`);
    console.log("  clawflare deploy");
    console.log("  clawflare open");
  } else {
    console.log("  # Install dependencies manually");
    console.log("  clawflare deploy");
    console.log("  clawflare open");
  }
}
