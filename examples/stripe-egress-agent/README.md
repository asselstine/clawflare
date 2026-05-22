# Stripe Egress Agent Example

A Clawflare agent with custom egress handler for Stripe API.

## Features

- Custom egress handler for `api.stripe.com`
- Automatic API key injection
- Request signing and validation
- Stripe API tools

## Setup

```bash
# Copy example
cp -r examples/stripe-egress-agent my-agent
cd my-agent

# Install dependencies
npm install

# Set Stripe secret key
clawflare secret set STRIPE_SECRET_KEY

# Deploy
clawflare deploy

# Open TUI
clawflare open
```

## Configuration

The egress handler intercepts requests to `api.stripe.com` and adds authentication:

```typescript
import { egressHandlers } from "./src/egress";

export default defineClawflareConfig({
  name: "stripe-agent",
  egressHandlers
});
```

## Custom Egress Handler

```typescript
// src/egress.ts
import { defineEgressHandler } from "@clawflare/egress-core";

export const egressHandlers = [
  defineEgressHandler({
    name: "stripe",
    domains: ["api.stripe.com"],
    
    async handles(request) {
      return new URL(request.url).hostname === "api.stripe.com";
    },
    
    async fetch(request, ctx) {
      const headers = new Headers(request.headers);
      headers.set("Authorization", `Bearer ${ctx.env.STRIPE_SECRET_KEY}`);
      
      // Add idempotency key for POST requests
      if (request.method === "POST") {
        headers.set("Idempotency-Key", crypto.randomUUID());
      }
      
      return fetch(new Request(request, { headers }));
    }
  })
];
```

## Custom Tools

```typescript
// src/tools.ts
import { defineTool } from "@clawflare/runtime";

export const tools = [
  defineTool({
    name: "create_customer",
    description: "Create a Stripe customer",
    parameters: {
      type: "object",
      properties: {
        email: { type: "string" },
        name: { type: "string" },
        description: { type: "string" }
      },
      required: ["email"]
    },
    execute: async ({ email, name, description }) => {
      const res = await fetch("https://api.stripe.com/v1/customers", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ email, ...(name && { name }), ...(description && { description }) })
      });
      return res.json();
    }
  })
];
```

## Usage

Ask the agent about Stripe:
- "Create a new customer with email foo@example.com"
- "List all customers"
- "Get customer details for cus_xxx"
- "Create a payment intent for $50"

## Security

The egress handler ensures:
- Stripe API key never leaves server-side
- Requests are authenticated before reaching Stripe
- Idempotency keys prevent duplicate charges
- All Stripe traffic goes through controlled gateway