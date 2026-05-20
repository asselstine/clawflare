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

import { AgentClient } from "@clawflare/cli";

const TEST_TOKEN = "test-token-12345";
const CF_API_TOKEN = process.env.CF_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN || "";
const CF_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || "";

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  duration: number;
}

class TestRunner {
  private results: TestResult[] = [];

  async runTest(name: string, testFn: () => Promise<void>): Promise<void> {
    const start = Date.now();
    process.stdout.write(`\n🔍 ${name}... `);

    try {
      await testFn();
      const duration = Date.now() - start;
      this.results.push({ name, passed: true, duration });
      process.stdout.write(`✅ (${duration}ms)\n`);
    } catch (error) {
      const duration = Date.now() - start;
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.results.push({ name, passed: false, error: errorMsg, duration });
      process.stdout.write(`❌ (${duration}ms)\n`);
      console.error(`   Error: ${errorMsg}`);
    }
  }

  printSummary(): void {
    const passed = this.results.filter((r) => r.passed).length;
    const failed = this.results.filter((r) => !r.passed).length;
    const totalDuration = this.results.reduce((sum, r) => sum + r.duration, 0);

    console.log("\n" + "=".repeat(60));
    console.log("📊 Test Results");
    console.log("=".repeat(60));
    console.log(`Total: ${this.results.length} | ✅ Passed: ${passed} | ❌ Failed: ${failed}`);
    console.log(`Total duration: ${totalDuration}ms`);

    if (failed > 0) {
      console.log("\n❌ Failed tests:");
      for (const r of this.results.filter((r) => !r.passed)) {
        console.log(`   - ${r.name}: ${r.error || "unknown error"}`);
      }
      process.exitCode = 1;
    } else {
      console.log("\n🎉 All tests passed!");
      process.exitCode = 0;
    }
  }
}

/**
 * Cloudflare Egress Integration Tests
 * 
 * Run with: pnpm test:cloudflare -- --url <worker-url>
 * 
 * Requires environment variables:
 * - CLOUDFLARE_API_TOKEN: A valid Cloudflare API token with:
 *   - Account: Account Settings (Read)
 *   - Account: Cloudflare Workers (Read)
 * - CLOUDFLARE_ACCOUNT_ID: Your Cloudflare account ID
 */
export async function runCloudflareEgressTests(url: string): Promise<void> {
  const runner = new TestRunner();
  const client = new AgentClient(url, TEST_TOKEN);

  console.log("🧪 Cloudflare Egress Handler Integration Tests");
  console.log("=".repeat(60));
  console.log(`   Target: ${url}`);
  console.log(`   CF_TOKEN: ${CF_API_TOKEN ? "✓ set (" + CF_API_TOKEN.substring(0, 10) + "...)" : "✗ NOT SET"}`);
  console.log(`   CF_ACCOUNT_ID: ${CF_ACCOUNT_ID ? "✓ set" : "✗ NOT SET"}`);
  console.log("");

  // Skip tests if credentials aren't available
  if (!CF_API_TOKEN || !CF_ACCOUNT_ID) {
    console.log("⚠️  Skipping tests - CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID required");
    console.log("   Set these environment variables to run integration tests against real Cloudflare API");
    return;
  }

  // Wait for server
  let ready = false;
  for (let i = 0; i < 30; i++) {
    try {
      const response = await fetch(`${url}/health`, { method: "GET" });
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
  console.log("✅ Remote Worker is responsive\n");

  // Check if harness is in mock mode
  const infoResponse = await fetch(`${url}/v1/info`, {
    headers: { Authorization: `Bearer ${TEST_TOKEN}` },
  });
  const infoData = await infoResponse.json() as { mockAi?: string };
  if (infoData.mockAi === "true") {
    console.log("⚠️  WARNING: Harness is running in MOCK_AI mode");
    console.log("   The Cloudflare egress handler will return mock responses");
    console.log("   Deploy with MOCK_AI unset to test real Cloudflare API calls\n");
  }

  await runner.runTest("Cloudflare egress handler is registered", async () => {
    const response = await fetch(`${url}/__test/search?collection=egress_handlers&q=cloudflare`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    const data = await response.json() as { results?: { egressHandlers: Array<{ name: string; domains?: string[] }> } };
    const handler = data.results?.egressHandlers.find((h) => h.name === "cloudflare");
    if (!handler) {
      throw new Error(`Cloudflare handler not found: ${JSON.stringify(data)}`);
    }
    if (!handler.domains?.includes("api.cloudflare.com")) {
      throw new Error(`Cloudflare handler missing api.cloudflare.com domain: ${JSON.stringify(handler)}`);
    }
  });

  await runner.runTest("execute_code can call Cloudflare API with auth headers", async () => {
    // Test that the Cloudflare API token is passed through the egress handler
    const testUrl = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/workers/scripts`;
    
    const response = await fetch(`${url}/__test/execute-code`, {
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
    if (!data.ok) {
      throw new Error(`execute_code failed: ${data.error}`);
    }
    
    // Should succeed (200) if auth works, 403 if auth fails
    if (data.result?.status === 403) {
      throw new Error(`Cloudflare API returned 403 - token may not have Workers:Read permission`);
    }
    if (data.result?.status !== 200) {
      throw new Error(`Expected status 200, got ${data.result?.status}: ${JSON.stringify(data.result?.result)}`);
    }
    if (!data.result?.result?.success) {
      throw new Error(`Cloudflare API returned success=false: ${JSON.stringify(data.result?.result)}`);
    }
  });

  await runner.runTest("Cloudflare egress passes CLOUDFLARE_API_TOKEN from env", async () => {
    // Verify that the harness env has the Cloudflare token configured
    const response = await fetch(`${url}/__test/execute-code`, {
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
    if (!data.ok) {
      throw new Error(`Failed to read env: ${JSON.stringify(data)}`);
    }
    if (!data.result?.hasCloudflareToken) {
      throw new Error("CLOUDFLARE_API_TOKEN not set in harness environment");
    }
    if (data.result.tokenLength < 10) {
      throw new Error(`CLOUDFLARE_API_TOKEN seems too short (${data.result.tokenLength} chars)`);
    }
  });

  await runner.runTest("execute_code lists Cloudflare workers correctly", async () => {
    // This is the actual use case from the bug report - listing workers
    const testUrl = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/workers/scripts`;
    
    const response = await fetch(`${url}/__test/execute-code`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TEST_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        code: `
          // List workers using the Cloudflare API
          const response = await fetch('${testUrl}');
          const data = await response.json();
          
          if (!response.ok) {
            return { 
              error: \`API error: \${response.status}\`, 
              details: data 
            };
          }
          
          return {
            status: response.status,
            workerCount: data.result?.length || 0,
            workers: data.result?.map((w: { id: string }) => w.id).slice(0, 5) || []
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
    
    if (!data.ok) {
      throw new Error(`execute_code failed: ${data.error}`);
    }
    
    if (data.result?.error) {
      throw new Error(`Cloudflare API error: ${data.result.error} - ${JSON.stringify(data.result)}`);
    }
    
    if (data.result?.status !== 200) {
      throw new Error(`Expected status 200, got ${data.result?.status}`);
    }
    
    console.log(`      Found ${data.result?.workerCount} workers: ${data.result?.workers.join(", ") || "none"}`);
  });

  await runner.runTest("gateway delegates to Cloudflare egress handler", async () => {
    // Test the gateway directly
    const testUrl = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}`;
    
    const response = await fetch(`${url}/__test/egress-fetch`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TEST_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ url: testUrl }),
    });
    
    const data = await response.json() as { ok: boolean; status?: number; body?: { success?: boolean } };
    if (!data.ok) {
      throw new Error(`Gateway request failed: ${JSON.stringify(data)}`);
    }
    
    // Should get 200 for a valid account lookup
    if (data.status === 403) {
      throw new Error(`Cloudflare API returned 403 - check token permissions`);
    }
    if (data.status !== 200) {
      throw new Error(`Expected status 200, got ${data.status}`);
    }
  });

  runner.printSummary();
}

function parseArgs(): { url: string | null; help: boolean } {
  const args = process.argv.slice(2);
  const urlIndex = args.indexOf("--url");
  return {
    url: urlIndex !== -1 ? args[urlIndex + 1] : null,
    help: args.includes("--help") || args.includes("-h"),
  };
}

function printHelp(): void {
  console.log(`
Cloudflare Egress Handler Integration Tests

Usage:
  pnpm test:cloudflare -- --url <worker-url>
  pnpm test:cloudflare -- --help

Environment variables:
  CLOUDFLARE_API_TOKEN    Required - API token with permissions:
                          - Account: Account Settings (Read)
                          - Account: Cloudflare Workers (Read)
  CLOUDFLARE_ACCOUNT_ID   Required - Your Cloudflare account ID
  CLOUDFLARE_API_TOKEN or CF_API_TOKEN (for Wrangler auth)

Example:
  CLOUDFLARE_API_TOKEN=your-token \
  CLOUDFLARE_ACCOUNT_ID=your-account-id \
  pnpm test:cloudflare -- --url https://clawflare-harness.your-account.workers.dev
`);
}

async function main(): Promise<void> {
  const { url, help } = parseArgs();

  if (help || !url) {
    printHelp();
    process.exit(help ? 0 : 1);
  }

  try {
    await runCloudflareEgressTests(url);
  } catch (error) {
    console.error("\n❌ Fatal error:", error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

// Run if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
