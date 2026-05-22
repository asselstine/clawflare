import { defineClawflareConfig } from "@clawflare/runtime";
import { github } from "@clawflare/github";
import { cloudflare } from "@clawflare/cloudflare";
import { tools } from "./src/tools";
import { egressHandlers } from "./src/egress";

export default defineClawflareConfig({
  name: "{{PROJECT_NAME}}",
  ai: {
    provider: "{{AI_PROVIDER}}",
    model: "{{AI_MODEL}}",
  },
  plugins: [
    github(),
    cloudflare(),
  ],
  tools: tools.length > 0 ? [() => tools] : [],
  egressHandlers: egressHandlers.length > 0 ? [() => egressHandlers] : [],
  secrets: [
    {
      name: "GITHUB_TOKEN",
      required: false,
      description: "GitHub API token for enhanced GitHub API access",
    },
    {
      name: "CLOUDFLARE_API_TOKEN",
      required: false,
      description: "Cloudflare API token for Cloudflare API access",
    },
  ],
});
