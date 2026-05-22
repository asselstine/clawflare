# Custom Egress Handlers

Control how your agent makes outbound HTTP requests.

## What is Egress?

Egress handlers intercept and modify outbound HTTP requests from:
- Dynamic Worker code execution
- Container workspace operations
- Custom tool fetch calls

## Define an Egress Handler

Create `src/egress.ts`:

```typescript
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
      headers.set("Authorization", `Bearer ${ctx.env.STRIPE_API_KEY}`);
      
      return fetch(new Request(request, { headers }));
    }
  })
];
```

## Handler API

```typescript
interface EgressHandlerConfig {
  name: string;           // Unique name
  domains: string[];      // Domains this handler manages
  
  handles(request: Request, ctx: EgressContext): Promise<boolean>;
  fetch(request: Request, ctx: EgressContext): Promise<Response>;
}

interface EgressContext {
  env: Env;                    // Cloudflare bindings
  handlerId: string;           // Handler instance ID
  next(request: Request): Promise<Response>;  // Continue to next handler
}
```

## Register Handlers

Add to your config:

```typescript
import { defineClawflareConfig } from "@clawflare/runtime";
import { egressHandlers } from "./src/egress";

export default defineClawflareConfig({
  name: "my-agent",
  egressHandlers
});
```

## Examples

### API Key Authentication

```typescript
defineEgressHandler({
  name: "weather_api",
  domains: ["api.weather.com"],
  
  async handles(request) {
    return new URL(request.url).hostname === "api.weather.com";
  },
  
  async fetch(request, ctx) {
    const url = new URL(request.url);
    url.searchParams.set("apikey", ctx.env.WEATHER_API_KEY);
    
    return fetch(new Request(url.toString(), request));
  }
})
```

### Request Signing

```typescript
defineEgressHandler({
  name: "signed_api",
  domains: ["api.example.com"],
  
  async handles(request) {
    return new URL(request.url).hostname === "api.example.com";
  },
  
  async fetch(request, ctx) {
    const timestamp = Date.now().toString();
    const signature = await signRequest(request, timestamp, ctx.env.API_SECRET);
    
    const headers = new Headers(request.headers);
    headers.set("X-Timestamp", timestamp);
    headers.set("X-Signature", signature);
    
    return fetch(new Request(request, { headers }));
  }
})

async function signRequest(request: Request, timestamp: string, secret: string): Promise<string> {
  const data = `${request.method}:${request.url}:${timestamp}`;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(signature)));
}
```

### Request/Response Logging

```typescript
defineEgressHandler({
  name: "logged_api",
  domains: ["api.internal.com"],
  
  async handles(request) {
    return new URL(request.url).hostname === "api.internal.com";
  },
  
  async fetch(request, ctx) {
    const start = Date.now();
    const requestId = crypto.randomUUID();
    
    console.log(`[${requestId}] → ${request.method} ${request.url}`);
    
    const response = await ctx.next(request);
    
    const duration = Date.now() - start;
    console.log(`[${requestId}] ← ${response.status} (${duration}ms)`);
    
    return response;
  }
})
```

### Caching Responses

```typescript
defineEgressHandler({
  name: "cached_api",
  domains: ["api.slow.com"],
  
  async handles(request) {
    return request.method === "GET" && 
           new URL(request.url).hostname === "api.slow.com";
  },
  
  async fetch(request, ctx) {
    const cacheKey = new URL(request.url).toString();
    const cached = await ctx.env.CACHE.get(cacheKey);
    
    if (cached) {
      return new Response(cached);
    }
    
    const response = await ctx.next(request);
    const body = await response.text();
    
    // Cache for 5 minutes
    await ctx.env.CACHE.put(cacheKey, body, { expirationTtl: 300 });
    
    return new Response(body, response);
  }
})
```

## Plugin Egress Handlers

Plugins can register their own egress handlers:

```typescript
// @clawflare/github plugin
export function github() {
  return {
    name: "github",
    egressHandlers: [
      defineEgressHandler({
        name: "github_api",
        domains: ["api.github.com", "raw.githubusercontent.com"],
        // ...
      })
    ]
  };
}
```

## Multiple Handlers

Handlers are evaluated in order. The first matching handler wins, or can call `ctx.next()` to continue:

```typescript
// Handler 1: Logging (matches all)
defineEgressHandler({
  name: "logger",
  domains: ["*"],
  
  async handles() { return true; },
  
  async fetch(request, ctx) {
    console.log(`Outgoing: ${request.url}`);
    const response = await ctx.next(request);
    console.log(`Response: ${response.status}`);
    return response;
  }
})

// Handler 2: Stripe auth (matches specific domain)
defineEgressHandler({
  name: "stripe_auth",
  domains: ["api.stripe.com"],
  
  async handles(request) {
    return new URL(request.url).hostname === "api.stripe.com";
  },
  
  async fetch(request, ctx) {
    // Add auth header
    // Doesn't call ctx.next(), so request goes directly to fetch
    return fetch(modifiedRequest);
  }
})
```

## Security Considerations

1. **Handler code is bundled** - Not stored in D1 at runtime
2. **Secrets from env** - Never hardcode credentials
3. **Domain validation** - Always check request URL
4. **Audit logging** - Log egress for security review