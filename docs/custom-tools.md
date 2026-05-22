# Custom Tools

Define custom tools that your agent can use to interact with external services.

## Define a Tool

Create `src/tools.ts`:

```typescript
import { defineTool } from "@clawflare/runtime";

export const tools = [
  defineTool({
    name: "lookup_customer",
    description: "Look up a customer by ID",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" }
      },
      required: ["id"]
    },
    execute: async ({ id }, ctx) => {
      // Access env, storage, and session
      const customer = await ctx.env.CUSTOMERS.get(id);
      return { customer };
    }
  }),

  defineTool({
    name: "calculate_price",
    description: "Calculate price with tax",
    parameters: {
      type: "object",
      properties: {
        amount: { type: "number" },
        taxRate: { type: "number" }
      },
      required: ["amount"]
    },
    execute: async ({ amount, taxRate = 0.08 }, ctx) => {
      const tax = amount * taxRate;
      return {
        subtotal: amount,
        tax,
        total: amount + tax
      };
    }
  })
];
```

## Tool Context

The second argument to `execute` provides context:

```typescript
interface ToolContext {
  env: Env;              // Cloudflare bindings
  ctx: ExecutionContext; // Execution context
  sessionId: string;     // Current session ID
  logger: Logger;        // Structured logger
}
```

## Register Tools

Add tools to your config:

```typescript
import { defineClawflareConfig } from "@clawflare/runtime";
import { tools } from "./src/tools";

export default defineClawflareConfig({
  name: "my-agent",
  tools
});
```

## Best Practices

1. **Keep descriptions clear** - The LLM uses these to choose tools
2. **Use specific parameter names** - "customerId" is better than "id"
3. **Return structured data** - Objects are easier for the LLM to understand
4. **Handle errors gracefully** - Return error messages, not exceptions
5. **Use JSON Schema for parameters** - Be precise about types

## Example: HTTP API Tool

```typescript
defineTool({
  name: "fetch_weather",
  description: "Get weather for a location",
  parameters: {
    type: "object",
    properties: {
      city: { type: "string" },
      units: { type: "string", enum: ["celsius", "fahrenheit"] }
    },
    required: ["city"]
  },
  execute: async ({ city, units = "celsius" }, ctx) => {
    const apiKey = ctx.env.WEATHER_API_KEY;
    const response = await fetch(
      `https://api.weather.com/v1/current?city=${city}&units=${units}&apikey=${apiKey}`
    );
    
    if (!response.ok) {
      return { error: "Weather service unavailable" };
    }
    
    const data = await response.json();
    return {
      city: data.city,
      temperature: data.temp,
      conditions: data.conditions,
      units
    };
  }
})
```

## Example: Database Tool

```typescript
defineTool({
  name: "save_note",
  description: "Save a note to the database",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string" },
      content: { type: "string" },
      tags: { type: "array", items: { type: "string" } }
    },
    required: ["title", "content"]
  },
  execute: async ({ title, content, tags = [] }, ctx) => {
    const id = crypto.randomUUID();
    const timestamp = Date.now();
    
    await ctx.env.DB.prepare(
      "INSERT INTO notes (id, title, content, tags, created_at) VALUES (?, ?, ?, ?, ?)"
    ).bind(id, JSON.stringify(tags), timestamp).run();
    
    return { id, success: true };
  }
})
```

## Built-in Tools

Clawflare provides these tools by default:

- `execute_code` - Run JavaScript in isolated Dynamic Worker
- `store_code` - Save reusable JavaScript by name
- `execute_stored_code` - Run stored JavaScript by name
- `search` - Query stored code and egress handler metadata

And 8 container workspace tools:
- `container_create`, `container_bash`, `container_read`, `container_write`
- `container_edit`, `container_grep`, `container_find`, `container_ls`
