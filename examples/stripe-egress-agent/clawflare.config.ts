import { defineClawflareConfig } from "@clawflare/runtime";
import { tools } from "./src/tools";
import { egressHandlers } from "./src/egress";

/**
 * Stripe Egress Agent Example
 * 
 * Demonstrates custom egress handler for Stripe API.
 * 
 * The egress handler intercepts requests to api.stripe.com
 * and automatically injects the STRIPE_SECRET_KEY.
 * 
 * Required secrets:
 * - STRIPE_SECRET_KEY: Your Stripe secret key (sk_test_... or sk_live_...)
 */
export default defineClawflareConfig({
  name: "stripe-egress-agent",
  
  ai: {
    provider: "anthropic",
    model: "claude-3-5-sonnet-20241022"
  },
  
  tools,
  egressHandlers,
  
  secrets: [
    {
      name: "STRIPE_SECRET_KEY",
      required: true,
      description: "Stripe secret API key (sk_test_... or sk_live_...)"
    }
  ]
});
