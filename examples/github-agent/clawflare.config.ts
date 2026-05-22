import { defineClawflareConfig } from "@clawflare/runtime";
import { github } from "@clawflare/github";

/**
 * GitHub Agent Example
 * 
 * Clawflare agent with GitHub API integration.
 * Requires GITHUB_TOKEN secret for API access.
 */
export default defineClawflareConfig({
  name: "github-agent",
  
  ai: {
    provider: "anthropic",
    model: "claude-3-5-sonnet-20241022"
  },
  
  plugins: [
    github()
  ],
  
  secrets: [
    {
      name: "GITHUB_TOKEN",
      required: true,
      description: "GitHub personal access token for API access"
    }
  ]
});
