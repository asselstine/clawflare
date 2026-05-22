/**
 * Clawflare CLI - init command
 * Creates a new Clawflare project
 */

import * as fs from "fs/promises";
import * as path from "path";
import { fileURLToPath } from "url";

interface InitOptions {
  template?: string;
  packageManager?: "npm" | "pnpm" | "yarn";
  noInstall?: boolean;
  provider?: string;
  model?: string;
}

const AVAILABLE_TEMPLATES = ["minimal", "github", "cloudflare", "full"];

/**
 * Get the path to the templates directory
 */
function getTemplatesDir(): string {
  // When running from compiled dist/, __dirname equivalent
  const currentFilePath = fileURLToPath(import.meta.url);
  const currentDir = path.dirname(currentFilePath);
  // Go up from src/commands/ to package root
  const packageRoot = path.resolve(currentDir, "..", "..");
  return path.join(packageRoot, "templates");
}

/**
 * Read a template file from the templates directory
 */
async function readTemplateFile(templateDir: string, filePath: string): Promise<string> {
  const fullPath = path.join(templateDir, filePath);
  return await fs.readFile(fullPath, "utf-8");
}

/**
 * Recursively get all files in a directory
 */
async function getFilesRecursively(dir: string, baseDir: string = dir): Promise<{ relativePath: string; content: string }[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: { relativePath: string; content: string }[] = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relativePath = path.relative(baseDir, fullPath);

    if (entry.isDirectory()) {
      const subFiles = await getFilesRecursively(fullPath, baseDir);
      files.push(...subFiles);
    } else {
      const content = await fs.readFile(fullPath, "utf-8");
      files.push({ relativePath, content });
    }
  }

  return files;
}

/**
 * Copy template files from the templates directory
 */
async function copyTemplateFiles(
  templateName: string,
  projectDir: string,
  variables: Record<string, string>
): Promise<void> {
  const templatesDir = getTemplatesDir();
  const templateDir = path.join(templatesDir, templateName);

  // Check if template exists
  try {
    await fs.access(templateDir);
  } catch {
    throw new Error(
      `Template "${templateName}" not found. Available templates: ${AVAILABLE_TEMPLATES.join(", ")}`
    );
  }

  // Get all template files
  const templateFiles = await getFilesRecursively(templateDir);

  // Write each file with variable substitution
  for (const { relativePath, content } of templateFiles) {
    const fullPath = path.join(projectDir, relativePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, renderTemplate(content, variables));
  }
}

function getPackageJson(projectName: string, template: string): string {
  const dependencies: Record<string, string> = {
    "@clawflare/runtime": "^0.1.0",
    "@clawflare/egress-core": "^0.1.0",
  };

  // Add plugin dependencies based on template
  if (template === "github" || template === "full") {
    dependencies["@clawflare/github"] = "^0.1.0";
  }
  if (template === "cloudflare" || template === "full") {
    dependencies["@clawflare/cloudflare"] = "^0.1.0";
  }

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
      dependencies,
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

  // Validate template
  const template = options.template || "minimal";
  if (!AVAILABLE_TEMPLATES.includes(template)) {
    console.error(
      `Error: Template "${template}" not found. Available templates: ${AVAILABLE_TEMPLATES.join(", ")}`
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

  console.log(`Creating Clawflare project "${projectName}" using template "${template}"...`);

  // Create directories
  await fs.mkdir(projectDir, { recursive: true });
  await fs.mkdir(path.join(projectDir, ".clawflare"), { recursive: true });
  await fs.mkdir(path.join(projectDir, "migrations"), { recursive: true });

  // Template variables
  const variables: Record<string, string> = {
    PROJECT_NAME: projectName,
    AI_PROVIDER: options.provider || "amazon-bedrock",
    AI_MODEL: options.model || "minimax.minimax-m2.5",
  };

  // Copy template files
  await copyTemplateFiles(template, projectDir, variables);

  // Write package.json with template-specific dependencies
  await fs.writeFile(path.join(projectDir, "package.json"), getPackageJson(projectName, template));

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