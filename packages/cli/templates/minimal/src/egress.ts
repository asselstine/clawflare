import { defineEgressHandler } from "@clawflare/egress-core";

// Define your custom egress handlers here
// Example:
// export const egressHandlers = [
//   defineEgressHandler({
//     name: "example",
//     domains: ["api.example.com"],
//     async handles(request) {
//       return new URL(request.url).hostname === "api.example.com";
//     },
//     async fetch(request, ctx) {
//       return fetch(request);
//     },
//   }),
// ];

export const egressHandlers = [];
