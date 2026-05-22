import { defineClawflareConfig } from "@clawflare/runtime";
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
    cloudflare(),
  ],
  tools: [
    () => tools,
  ],
  egressHandlers: [
    () => egressHandlers,
  ],
});
