import { defineClawflareConfig } from "@clawflare/runtime";
import { github } from "@clawflare/github";
import { egressHandlers } from "./src/egress";

export default defineClawflareConfig({
  name: "{{PROJECT_NAME}}",
  ai: {
    provider: "{{AI_PROVIDER}}",
    model: "{{AI_MODEL}}",
  },
  plugins: [
    github(),
  ],
  egressHandlers: [
    () => egressHandlers,
  ],
});
