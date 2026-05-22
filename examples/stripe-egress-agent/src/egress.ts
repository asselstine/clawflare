import { defineEgressHandler } from "@clawflare/egress-core";

/**
 * Stripe API Egress Handler
 * 
 * Intercepts all requests to api.stripe.com and:
 * - Injects STRIPE_SECRET_KEY as Bearer token
 * - Adds idempotency key for POST requests
 * - Adds user-agent for tracking
 */
export const egressHandlers = [
  defineEgressHandler({
    name: "stripe_api",
    domains: ["api.stripe.com"],
    
    async handles(request: Request) {
      const url = new URL(request.url);
      return url.hostname === "api.stripe.com";
    },
    
    async fetch(request: Request, ctx: any) {
      const headers = new Headers(request.headers);
      
      // Add Stripe authentication
      const stripeKey = ctx.env.STRIPE_SECRET_KEY;
      if (!stripeKey) {
        throw new Error("STRIPE_SECRET_KEY not configured");
      }
      headers.set("Authorization", `Bearer ${stripeKey}`);
      
      // Add idempotency key for POST requests (prevents duplicate operations)
      if (request.method === "POST" && !headers.has("Idempotency-Key")) {
        headers.set("Idempotency-Key", crypto.randomUUID());
      }
      
      // Add user agent
      headers.set("User-Agent", "clawflare-stripe-agent/1.0");
      
      // Create modified request
      const modifiedRequest = new Request(request, { headers });
      
      // Forward to Stripe
      return fetch(modifiedRequest);
    }
  })
];
