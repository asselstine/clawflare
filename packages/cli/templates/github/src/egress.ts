import { defineEgressHandler } from "@clawflare/runtime";
import type { EgressHandler } from "@clawflare/runtime";

// Define your custom egress handlers here
// See https://github.com/asselstine/clawflare for documentation

// Example custom egress handler:
// export const egressHandlers: EgressHandler[] = [
//   defineEgressHandler({
//     name: "stripe",
//     description: "Stripe API access with automatic authentication",
//     domains: ["api.stripe.com"],
//     async handles(request) {
//       return new URL(request.url).hostname === "api.stripe.com";
//     },
//     async fetch(request, ctx) {
//       const headers = new Headers(request.headers);
//       const apiKey = (ctx.env as Record<string, string>).STRIPE_API_KEY;
//       if (apiKey) {
//         headers.set("Authorization", `Bearer ${apiKey}`);
//       }
//       return fetch(new Request(request, { headers }));
//     },
//   }),
// ];

export const egressHandlers: EgressHandler[] = [];
