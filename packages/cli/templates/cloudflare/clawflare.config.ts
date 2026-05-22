import { defineClawflareConfig } from "@clawflare/runtime";
import { cloudflare } from "@clawflare/cloudflare";
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
  egressHandlers: [
    () => egressHandlers,
  ],
});
