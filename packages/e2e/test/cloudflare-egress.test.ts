/**
 * Cloudflare Egress Handler Integration Tests
 * 
 * These tests verify that the Cloudflare egress handler is working correctly
 * and adds the proper authentication headers to API requests.
 * 
 * Prerequisites:
 * - CLOUDFLARE_API_TOKEN environment variable must be set with a valid token
 *   that has the following permissions:
 *   - Account:Read (for reading account info)
 *   - Cloudflare Workers:Read (for listing workers/scripts)
 * - CLOUDFLARE_ACCOUNT_ID environment variable must be set with your account ID
 * - The harness must be deployed with MOCK_AI not set to "true" (mock mode
 *   returns fake responses instead of making real API calls)
 * 
 * To create a token with the required permissions:
 * 1. Go to https://dash.cloudflare.com/profile/api-tokens
 * 2. Click "Create Token" 
 * 3. Use the "Custom token" template
 * 4. Add permissions:
 *    - Account → Account Settings → Read
 *    - Account → Cloudflare Workers → Read
 * 5. Set Account Resources to include your account
 * 6. Create and copy the token
 * 
 * To test against a deployed harness:
 *   CLOUDFLARE_API_TOKEN=your-token \
 *   CLOUDFLARE_ACCOUNT_ID=your-account-id \
 *   pnpm test:cloudflare -- --url https://your-harness-url.workers.dev
 * 
 * Note: This test is designed to run against a production harness deployment
 * or a test deployment with real credentials. The default E2E test deployment
 * uses MOCK_AI=true which causes the Cloudflare egress handler to return mock
 * responses instead of calling the real Cloudflare API.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { AgentClient } from "@clawflare/cli";

const TEST_TOKEN = "test-token-12345";
const CF_API_TOKEN = process.env.CF_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN || "";
const CF_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || "";

// Parse URL from environment or args
const TEST_URL = process.env.TEST_URL || process.env.HARNESS_URL || (process.argv.find((arg, i) => process.argv[i - 1] === "--url") ?? null);

// Skip tests if no URL provided
const shouldSkip = !TEST_URL;

describe("Cloudflare Egress Integration Tests", () => {
  beforeAll(async () => {
    if (shouldSkip) {
      console.log("⚠️  Skipping tests - No harness URL provided. Set TEST_URL or use --url flag.");
      return;
    }
    
    // Wait for server
    let ready = false;
    for (let i = 0; i < 30; i++) {
      try {
        const response = await fetch(`${TEST_URL}/health`, { method: "GET" });
        if (response.ok) {
          ready = true;
          break;
        }
      } catch {
        // Remote route may not be propagated yet
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    if (!ready) throw new Error("Remote Worker failed to become responsive");
    console.log("✅ Remote Worker is responsive");
  }, 35000);

  it("should have Cloudflare egress handler registered", async () => {
    if (shouldSkip) {
      console.log("⚠️  Skipping - no harness URL");
      return;
    }
    
    const response = await fetch(`${TEST_URL}/__test/search?collection=egress_handlers&q=cloudflare`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    const data = await response.json() as { results?: { egressHandlers: Array<{ name: string; domains?: string[] }> } };
    const handler = data.results?.egressHandlers.find((h) => h.name === "cloudflare");
    expect(handler).toBeDefined();
    expect(handler?.domains).toContain("api.cloudflare.com");
  }, 10000);

  it("execute_code can call Cloudflare API with auth headers", async () => {
    if (shouldSkip || !CF_API_TOKEN || !CF_ACCOUNT_ID) {
      console.log("⚠️  Skipping - need CF_API_TOKEN and CLOUDFLARE_ACCOUNT_ID");
      return;
    }
    
    // Test that the Cloudflare API token is passed through the egress handler
    const testUrl = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/workers/scripts`;
    
    const response = await fetch(`${TEST_URL}/__test/execute-code`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TEST_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        code: `
          const response = await fetch('${testUrl}', {
            headers: { 'Content-Type': 'application/json' }
          });
          const body = await response.json();
          return { status: response.status, result: body };
        `,
      }),
    });
    
    const data = await response.json() as { ok: boolean; result?: { status: number; result?: { success?: boolean } }; error?: string };
    expect(data.ok).toBe(true);
    expect(data.result?.status).toBe(200);
    expect(data.result?.result?.success).toBe(true);
  }, 30000);

  it("Cloudflare egress passes CLOUDFLARE_API_TOKEN from env", async () => {
    if (shouldSkip) {
      console.log("⚠️  Skipping - no harness URL");
      return;
    }
    
    const response = await fetch(`${TEST_URL}/__test/execute-code`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TEST_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        code: `
          // Check that we can access the env
          return { 
            hasCloudflareToken: !!env.CLOUDFLARE_API_TOKEN,
            tokenLength: env.CLOUDFLARE_API_TOKEN?.length || 0
          };
        `,
      }),
    });
    
    const data = await response.json() as { ok: boolean; result?: { hasCloudflareToken: boolean; tokenLength: number } };
    expect(data.ok).toBe(true);
    expect(data.result?.hasCloudflareToken).toBe(true);
    expect(data.result?.tokenLength).toBeGreaterThanOrEqual(10);
  }, 10000);

  it("execute_code lists Cloudflare workers correctly", async () => {
    if (shouldSkip || !CF_API_TOKEN || !CF_ACCOUNT_ID) {
      console.log("⚠️  Skipping - need CF_API_TOKEN and CLOUDFLARE_ACCOUNT_ID");
      return;
    }
    
    const testUrl = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/workers/scripts`;
    
    const response = await fetch(`${TEST_URL}/__test/execute-code`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TEST_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        code: `
          const response = await fetch('${testUrl}');
          const data = await response.json();
          
          if (!response.ok) {
            return { error: \`API error: \${response.status}\`, details: data };
          }
          
          return {
            status: response.status,
            workerCount: data.result?.length || 0,
            workers: data.result?.map((w) => w.id).slice(0, 5) || []
          };
        `,
      }),
    });
    
    const data = await response.json() as { 
      ok: boolean; 
      result?: { 
        error?: string; 
        status: number; 
        workerCount: number;
        workers: string[];
      }; 
      error?: string 
    };
    
    expect(data.ok).toBe(true);
    expect(data.result?.error).toBeUndefined();
    expect(data.result?.status).toBe(200);
    expect(typeof data.result?.workerCount).toBe("number");
  }, 30000);

  it("gateway delegates to Cloudflare egress handler", async () => {
    if (shouldSkip || !CF_API_TOKEN || !CF_ACCOUNT_ID) {
      console.log("⚠️  Skipping - need CF_API_TOKEN and CLOUDFLARE_ACCOUNT_ID");
      return;
    }
    
    const testUrl = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}`;
    
    const response = await fetch(`${TEST_URL}/__test/egress-fetch`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TEST_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ url: testUrl }),
    });
    
    const data = await response.json() as { ok: boolean; status?: number; body?: { success?: boolean } };
    expect(data.ok).toBe(true);
    expect(data.status).toBe(200);
  }, 30000);
});
