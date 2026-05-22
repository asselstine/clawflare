import { defineClawflareConfig } from "@clawflare/runtime";

/**
 * Minimal Clawflare agent configuration.
 * 
 * This example shows the simplest possible config.
 * Uses default AI provider (Bedrock with Minimax) and built-in tools.
 */
export default defineClawflareConfig({
  name: "minimal-agent"
});
