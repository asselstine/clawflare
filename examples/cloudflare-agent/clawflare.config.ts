import { defineClawflareConfig } from "@clawflare/runtime";
import { cloudflare } from "@clawflare/cloudflare";

/**
 * Cloudflare Agent Example
 * 
 * Clawflare agent with Cloudflare API integration.
 * Uses your existing CLOUDFLARE_API_TOKEN for API access.
 */
export default defineClawflareConfig({
  name: "cloudflare-agent",
  
  ai: {
    provider: "anthropic",
    model: "claude-3-5-sonnet-20241022"
  },
  
  plugins: [
    cloudflare()
  ]
});
