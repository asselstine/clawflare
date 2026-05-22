import { defineTool } from "@clawflare/runtime";
import type { UserToolDefinition } from "@clawflare/runtime";

// Define your custom tools here
// See https://github.com/asselstine/clawflare for documentation

// Example custom tool:
// export const tools: UserToolDefinition[] = [
//   defineTool({
//     name: "hello",
//     description: "Say hello to someone",
//     parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
//     execute: async ({ name }) => ({ message: `Hello, ${name}!` }),
//   }),
// ];

export const tools: UserToolDefinition[] = [];
