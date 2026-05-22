import { defineTool } from "@clawflare/runtime";

/**
 * Stripe Tools
 * 
 * Custom tools for Stripe API operations.
 * Requests go through egress handler which adds authentication.
 */
export const tools = [
  defineTool({
    name: "create_stripe_customer",
    description: "Create a new Stripe customer",
    parameters: {
      type: "object",
      properties: {
        email: { type: "string", description: "Customer email" },
        name: { type: "string", description: "Customer name" },
        description: { type: "string", description: "Customer description" },
        phone: { type: "string", description: "Customer phone number" }
      },
      required: ["email"]
    },
    execute: async ({ email, name, description, phone }) => {
      const params = new URLSearchParams();
      params.append("email", email);
      if (name) params.append("name", name);
      if (description) params.append("description", description);
      if (phone) params.append("phone", phone);
      
      const response = await fetch("https://api.stripe.com/v1/customers", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params
      });
      
      if (!response.ok) {
        const error = await response.json();
        throw new Error(`Stripe error: ${error.error?.message || response.statusText}`);
      }
      
      return response.json();
    }
  }),

  defineTool({
    name: "list_stripe_customers",
    description: "List Stripe customers",
    parameters: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Number of customers to return (max 100)", default: 10 },
        email: { type: "string", description: "Filter by email" }
      }
    },
    execute: async ({ limit = 10, email }) => {
      const params = new URLSearchParams();
      params.append("limit", Math.min(limit, 100).toString());
      if (email) params.append("email", email);
      
      const response = await fetch(`https://api.stripe.com/v1/customers?${params}`, {
        headers: { "Content-Type": "application/x-www-form-urlencoded" }
      });
      
      if (!response.ok) {
        const error = await response.json();
        throw new Error(`Stripe error: ${error.error?.message || response.statusText}`);
      }
      
      const data = await response.json();
      return {
        customers: data.data,
        has_more: data.has_more
      };
    }
  }),

  defineTool({
    name: "get_stripe_customer",
    description: "Get a Stripe customer by ID",
    parameters: {
      type: "object",
      properties: {
        customerId: { type: "string", description: "Stripe customer ID (cus_xxx)" }
      },
      required: ["customerId"]
    },
    execute: async ({ customerId }) => {
      const response = await fetch(`https://api.stripe.com/v1/customers/${customerId}`);
      
      if (!response.ok) {
        const error = await response.json();
        throw new Error(`Stripe error: ${error.error?.message || response.statusText}`);
      }
      
      return response.json();
    }
  })
];
