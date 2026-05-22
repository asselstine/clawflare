import { defineClawflareConfig } from "@clawflare/runtime";
import { tools } from "./src/tools";
import { egressHandlers } from "./src/egress";

export default defineClawflareConfig({
  name: "{{PROJECT_NAME}}",
  ai: {
    provider: "{{AI_PROVIDER}}",
    model: "{{AI_MODEL}}",
  },
  tools: tools.length > 0 ? [() => tools] : [],
  egressHandlers: egressHandlers.length > 0 ? [() => egressHandlers] : [],
});
