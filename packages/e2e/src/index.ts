/**
 * E2E Tests for Clawflare
 *
 * This package deploys the harness worker locally using wrangler dev
 * and runs comprehensive API tests against it.
 *
 * Usage:
 *   pnpm test                    # Run automated tests
 *   pnpm test --ui               # Manual testing with CLI
 *   pnpm test --keep-alive     # Run tests but keep dev server alive
 *   pnpm test --help             # Show help
 */

import { spawn, type ChildProcess } from "node:child_process";
import { resolve as pathResolve } from "node:path";
import { AgentClient } from "@clawflare/cli";
import { createServer } from "node:net";

const TEST_TOKEN = "test-token-12345";
const CF_API_TOKEN = process.env.CF_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN || "";

// Find an available port dynamically
async function findAvailablePort(startPort = 8787, maxAttempts = 100): Promise<number> {
  for (let port = startPort; port < startPort + maxAttempts; port++) {
    try {
      const server = createServer();
      await new Promise<void>((resolve, reject) => {
        server.once("error", (err: NodeJS.ErrnoException) => {
          if (err.code === "EADDRINUSE") {
            resolve(); // Port in use, try next
          } else {
            reject(err);
          }
        });
        server.once("listening", () => {
          server.close(() => resolve());
        });
        server.listen(port);
      });
      // If we get here without error, the port is available
      return port;
    } catch {
      // Continue to next port
    }
  }
  throw new Error(`Could not find available port between ${startPort} and ${startPort + maxAttempts}`);
}

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
 * Deploy the harness locally using wrangler dev
 * Returns the process and URL
 */
async function deployLocal(): Promise<{ process: ChildProcess; url: string; port: number }> {
  const port = await findAvailablePort();
  const localUrl = `http://localhost:${port}`;
  
  console.log("🚀 Starting wrangler dev server...");
  console.log(`   Working directory: ${pathResolve(process.cwd(), "..", "harness")}`);
  console.log(`   Port: ${port}`);
  console.log("");

  return new Promise((resolve, reject) => {
    // Build wrangler dev args - include Cloudflare token if available
    const wranglerArgs = [
      "exec", "wrangler", "dev",
      "--config", "wrangler.test.jsonc",
      "--port", String(port),
      "--local",
      "--var", `CLAWFLARE_API_TOKEN:${TEST_TOKEN}`,
    ];
    
    // Add Cloudflare token if available (needed for AI to work)
    if (CF_API_TOKEN) {
      wranglerArgs.push("--var", `CLOUDFLARE_API_TOKEN:${CF_API_TOKEN}`);
    }
    
    // Always use mock AI for E2E tests (real AI doesn't work well in local dev)
    wranglerArgs.push("--var", "MOCK_AI:true");
    
    const proc = spawn(
      "pnpm",
      wranglerArgs,
      {
        cwd: pathResolve(process.cwd(), "..", "harness"),
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
        env: {
          ...process.env,
          CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN || "",
          // Force mock AI mode for E2E tests (real AI doesn't work in local dev)
          MOCK_AI: "true",
        },
      }
    );

    let ready = false;
    let output = "";
    let errorOutput = "";
    let startupTimeout: ReturnType<typeof setTimeout> | undefined;
    
    const cleanup = () => {
      if (startupTimeout) {
        clearTimeout(startupTimeout);
        startupTimeout = undefined;
      }
      proc.stdout?.removeAllListeners("data");
      proc.stderr?.removeAllListeners("data");
      proc.removeAllListeners("exit");
      proc.removeAllListeners("error");
    };

    const resolveReady = (message: string) => {
      if (ready) return;
      ready = true;
      cleanup();
      console.log(message);
      resolve({ process: proc, url: localUrl, port });
    };

    const rejectStartup = (error: Error) => {
      cleanup();
      reject(error);
    };

    const checkReady = (data: string) => {
      output += data;

      // Check for ready message patterns
      if (
        data.includes("Ready on") ||
        data.includes("Local:") ||
        data.includes(`http://localhost:${port}`) ||
        data.includes("Listening on")
      ) {
        resolveReady(`\n✅ Dev server is ready on port ${port}!\n`);
      }
    };

    proc.stdout?.on("data", checkReady);
    proc.stderr?.on("data", (data) => {
      const text = data.toString();
      errorOutput += text;
      process.stderr.write(text);
      checkReady(text);
    });

    proc.on("error", (err) => {
      rejectStartup(new Error(`Failed to start wrangler dev: ${err.message}`));
    });

    proc.on("exit", (code) => {
      if (!ready && code !== 0) {
        rejectStartup(new Error(`wrangler dev exited with code ${code}. Error output: ${errorOutput}`));
      }
    });

    // Hard timeout - fail if server doesn't start within 30 seconds
    startupTimeout = setTimeout(() => {
      if (!ready) {
        rejectStartup(new Error(`wrangler dev failed to start within 30 seconds. Output: ${output}`));
      }
    }, 30000);
  });
}

/**
 * Wait for the server to be responsive
 */
async function waitForServer(url: string, maxAttempts = 30): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const response = await fetch(`${url}/health`, { method: "GET" });
      if (response.ok) {
        return true;
      }
    } catch {
      // Server not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

/**
 * Run all API tests
 */
async function runTests(url: string, token: string): Promise<void> {
  const runner = new TestRunner();
  const client = new AgentClient(url, token);

  console.log("🧪 Starting E2E Tests");
  console.log(`   Target: ${url}`);
  console.log(`   Token: ${token.substring(0, 10)}...`);

  // Wait for server to be ready
  const ready = await waitForServer(url);
  if (!ready) {
    throw new Error("Server failed to become responsive");
  }
  console.log("✅ Server is responsive\n");

  // === Health Endpoint Tests ===
  await runner.runTest("Health check - unauthenticated", async () => {
    const response = await fetch(`${url}/health`);
    if (!response.ok) {
      throw new Error(`Expected OK, got ${response.status}`);
    }
    const data = await response.json();
    if (data.status !== "ok") {
      throw new Error(`Expected status "ok", got ${JSON.stringify(data)}`);
    }
  });

  // === Authentication Tests ===
  await runner.runTest("Unauthorized - missing auth header", async () => {
    const response = await fetch(`${url}/v1/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "prompt", content: "hello" }),
    });
    if (response.status !== 401) {
      throw new Error(`Expected 401, got ${response.status}`);
    }
  });

  await runner.runTest("Unauthorized - wrong token", async () => {
    const response = await fetch(`${url}/v1/chat`, {
      method: "POST",
      headers: {
        "Authorization": "Bearer wrong-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ type: "prompt", content: "hello" }),
    });
    if (response.status !== 401) {
      throw new Error(`Expected 401, got ${response.status}`);
    }
  });

  await runner.runTest("Authorized - valid token", async () => {
    const response = await fetch(`${url}/v1/chat`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ type: "prompt", content: "hello" }),
    });
    // Should not be 401 (could be other errors, but not auth)
    if (response.status === 401) {
      throw new Error("Valid token was rejected");
    }
  });

  // === Context Tests ===
  await runner.runTest("Get context - authorized", async () => {
    const context = await client.getContext();
    if (!context.id) {
      throw new Error("Context missing ID");
    }
    if (!Array.isArray(context.messages)) {
      throw new Error("Context messages not an array");
    }
  });

  await runner.runTest("Create new context", async () => {
    const oldContextId = client.getCurrentContextId();
    const context = await client.createContext();
    if (!context.id) {
      throw new Error("New context missing ID");
    }
    if (context.id === oldContextId) {
      throw new Error("New context has same ID as old context");
    }
  });

  await runner.runTest("Create context with parent", async () => {
    const parentContext = await client.createContext();
    if (!parentContext.id) {
      throw new Error("Failed to create parent context");
    }

    console.log("\n   Creating child context...");
    const childContext = await client.createContext(parentContext.id);
    if (childContext.parentId !== parentContext.id) {
      throw new Error(`Expected parentId ${parentContext.id}, got ${childContext.parentId}`);
    }
    console.log(`   Parent: ${parentContext.id}`);
    console.log(`   Child: ${childContext.id}`);
  });

  // === Chat/Prompt Tests ===
  await runner.runTest("Simple prompt", async () => {
    const response = await client.chat({ type: "prompt", content: "Say 'hello'" });
    if (response.type !== "message") {
      throw new Error(`Expected type "message", got "${response.type}"`);
    }
    // Response may be empty if agent is not fully configured
    // We just verify the API works
    console.log(`\n   Response: "${response.content?.substring(0, 100) || '(empty)'}"`);
  });

  // === Session History Tests ===
  // Note: These tests verify that message history is preserved across prompts.
  // The message count includes ALL previous prompts in the same context.
  await runner.runTest("Session history preserved - first message", async () => {
    // Send a message with a unique identifier
    const uniqueId = `test-${Date.now()}-first`;
    const response1 = await client.chat({ type: "prompt", content: `Remember this: ${uniqueId}` });
    if (response1.type !== "message") {
      throw new Error(`First prompt failed: ${response1.type}`);
    }
    console.log(`\n   First response: "${response1.content?.substring(0, 100)}"`);
  });

  await runner.runTest("Session history preserved - HISTORY_TEST with context", async () => {
    // Use the HISTORY_TEST keyword which makes the mock echo back all user messages
    const response = await client.chat({ type: "prompt", content: "HISTORY_TEST: What messages have I sent?" });
    if (response.type !== "message") {
      throw new Error(`HISTORY_TEST prompt failed: ${response.type}`);
    }
    
    // The mock should echo back previous messages
    if (!response.content?.includes("HISTORY_TEST_MODE")) {
      throw new Error(`Expected HISTORY_TEST_MODE in response, got: ${response.content}`);
    }
    
    // Should find at least 2 messages in total (this test + at least one previous)
    const match = response.content.match(/Found (\d+) user messages/);
    const count = match ? parseInt(match[1], 10) : 0;
    if (count < 2) {
      throw new Error(`Expected to find at least 2 user messages in history, but found ${count}. Response was: ${response.content}`);
    }
    
    console.log(`\n   History verification response: "${response.content}"`);
  });

  await runner.runTest("Session history preserved - third message adds to history", async () => {
    // Send another HISTORY_TEST to verify messages accumulate
    const response = await client.chat({ type: "prompt", content: "HISTORY_TEST: Confirm history" });
    if (response.type !== "message") {
      throw new Error(`Third prompt failed: ${response.type}`);
    }
    
    // Should have more messages than before (history is accumulating)
    const match = response.content?.match(/Found (\d+) user messages/);
    const count = match ? parseInt(match[1], 10) : 0;
    if (count < 3) {
      throw new Error(`Expected to find at least 3 user messages in accumulated history, but found ${count}. Response was: ${response.content}`);
    }
    
    console.log(`\n   Third message history: "${response.content}"`);
  });

  await runner.runTest("Fork context", async () => {
    // Reset to a clean context first
    const context = await client.createContext();
    if (!context.id) {
      throw new Error("Failed to create context");
    }

    // forkContext returns the new ContextInfo
    // First verify the context was created
    const originalId = context.id;
    const newContext = await client.forkContext();
    if (!newContext.id) {
      throw new Error("Fork failed - no context ID returned");
    }
    // Verify it's a different context
    if (newContext.id === originalId) {
      throw new Error("Fork returned same context ID");
    }
    // The forked context may or may not have messages copied, but it should have an ID
    console.log(`\n   Forked: ${originalId} -> ${newContext.id}`);
  });

  await runner.runTest("Steer message", async () => {
    const response = await client.chat({ type: "steer", content: "Be more helpful" });
    if (response.type !== "message") {
      throw new Error(`Expected type "message", got "${response.type}"`);
    }
  });

  // === Tool Tests ===
  await runner.runTest("List tools", async () => {
    const tools = await client.listTools();
    if (!Array.isArray(tools)) {
      throw new Error("Tools not returned as array");
    }
    
    // Verify exactly the four expected tools
    const toolNames = tools.map(t => t.name).sort();
    const expectedTools = ["execute_code", "execute_stored_code", "search", "store_code"].sort();
    
    if (JSON.stringify(toolNames) !== JSON.stringify(expectedTools)) {
      throw new Error(`Expected tools: ${JSON.stringify(expectedTools)}, got: ${JSON.stringify(toolNames)}`);
    }
    
    // Verify old tools are NOT present
    const oldTools = ["deploy_tool", "list_workers", "get_worker", "create_kv", "create_d1", "list_resources"];
    for (const oldTool of oldTools) {
      if (tools.some(t => t.name === oldTool)) {
        throw new Error(`Old tool should not be present: ${oldTool}`);
      }
    }
    
    console.log(`\n   Available tools: ${tools.length}`);
    for (const tool of tools) {
      console.log(`   - ${tool.name}: ${tool.description.substring(0, 50)}...`);
    }
  });

  // === Skills endpoint removal ===
  await runner.runTest("Skills endpoint removed", async () => {
    const response = await fetch(`${url}/v1/skills`, {
      headers: { "Authorization": `Bearer ${token}` },
    });
    if (response.status !== 404) {
      throw new Error(`Expected /v1/skills to return 404, got ${response.status}`);
    }
  });

  // === Stored Code and Dynamic Worker Tests ===
  await runner.runTest("execute_code runs inline Dynamic Worker code", async () => {
    const response = await fetch(`${url}/__test/execute-code`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ code: "return { message: 'ok', input };", input: { value: 42 } }),
    });
    const data = await response.json() as { ok: boolean; result?: { message?: string; input?: { value?: number } }; error?: string };
    if (!data.ok || data.result?.message !== "ok" || data.result?.input?.value !== 42) {
      throw new Error(`Unexpected execute_code result: ${JSON.stringify(data)}`);
    }
  });

  await runner.runTest("store_code stores reusable code", async () => {
    const response = await fetch(`${url}/__test/store-code`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "double_number",
        description: "Doubles a numeric input",
        code: "return input.value * 2;",
      }),
    });
    const data = await response.json() as { ok: boolean; error?: string };
    if (!data.ok) throw new Error(`store_code failed: ${JSON.stringify(data)}`);
  });

  await runner.runTest("search finds stored code metadata", async () => {
    const response = await fetch(`${url}/__test/search?collection=stored_code&q=double`, {
      headers: { "Authorization": `Bearer ${token}` },
    });
    const data = await response.json() as { ok: boolean; results?: { storedCode: Array<{ name: string; code?: string }> } };
    const found = data.results?.storedCode.find((item) => item.name === "double_number");
    if (!data.ok || !found) throw new Error(`Stored code not found: ${JSON.stringify(data)}`);
    if (found.code) throw new Error("Search should not return stored code body");
  });

  await runner.runTest("execute_stored_code runs named code", async () => {
    const response = await fetch(`${url}/__test/execute-stored-code`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "double_number", input: { value: 21 } }),
    });
    const data = await response.json() as { ok: boolean; result?: number; error?: string };
    if (!data.ok || data.result !== 42) {
      throw new Error(`Unexpected execute_stored_code result: ${JSON.stringify(data)}`);
    }
  });

  // === Egress Tests ===
  await runner.runTest("search finds GitHub and Cloudflare egress handlers", async () => {
    const githubResponse = await fetch(`${url}/__test/search?collection=egress_handlers&q=api.github.com`, {
      headers: { "Authorization": `Bearer ${token}` },
    });
    const github = await githubResponse.json() as { results?: { egressHandlers: Array<{ name: string }> } };
    if (!github.results?.egressHandlers.some((handler) => handler.name === "github")) {
      throw new Error(`GitHub handler not found: ${JSON.stringify(github)}`);
    }

    const cloudflareResponse = await fetch(`${url}/__test/search?collection=egress_handlers&q=api.cloudflare.com`, {
      headers: { "Authorization": `Bearer ${token}` },
    });
    const cloudflare = await cloudflareResponse.json() as { results?: { egressHandlers: Array<{ name: string }> } };
    if (!cloudflare.results?.egressHandlers.some((handler) => handler.name === "cloudflare")) {
      throw new Error(`Cloudflare handler not found: ${JSON.stringify(cloudflare)}`);
    }
  });

  await runner.runTest("unsupported egress is blocked", async () => {
    const response = await fetch(`${url}/__test/execute-code`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        code: "const response = await fetch('https://example.com'); return { status: response.status, body: await response.text() };",
      }),
    });
    const data = await response.json() as { ok: boolean; result?: { status?: number }; error?: string };
    if (data.ok && data.result?.status !== 403) {
      throw new Error(`Expected unsupported egress to be blocked, got: ${JSON.stringify(data)}`);
    }
  });

  await runner.runTest("gateway delegates matching egress handler", async () => {
    const response = await fetch(`${url}/__test/egress-fetch`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ url: "https://api.github.com" }),
    });
    const data = await response.json() as { ok: boolean; status?: number; body?: { handler?: string }; error?: string };
    if (!data.ok || data.status !== 200 || data.body?.handler !== "github") {
      throw new Error(`Expected GitHub egress handler delegation, got: ${JSON.stringify(data)}`);
    }
  });

  // === 404 Tests ===
  await runner.runTest("404 on unknown endpoint", async () => {
    const response = await fetch(`${url}/unknown-endpoint`, {
      headers: { "Authorization": `Bearer ${token}` },
    });
    if (response.status !== 404) {
      throw new Error(`Expected 404, got ${response.status}`);
    }
  });

  runner.printSummary();
}

/**
 * Manual testing mode - launches the CLI TUI
 */
async function runManualTesting(url: string, token: string): Promise<void> {
  console.log("\n🎨 Launching TUI for manual testing...");
  console.log(`   URL: ${url}`);
  console.log(`   Token: ${token}`);
  console.log("\n   Press Ctrl+C to exit.\n");

  const { runCli } = await import("@clawflare/cli");
  await runCli(url, token);
}

/**
 * Parse command line arguments
 */
function parseArgs(): { help: boolean; ui: boolean; keepAlive: boolean } {
  const args = process.argv.slice(2);
  return {
    help: args.includes("--help") || args.includes("-h"),
    ui: args.includes("--ui") || args.includes("-u"),
    keepAlive: args.includes("--keep-alive") || args.includes("-k"),
  };
}

function printHelp(): void {
  console.log(`
Clawflare E2E Tests

Usage:
  pnpm test                    Run automated tests
  pnpm test --ui               Launch TUI for manual testing
  pnpm test --keep-alive       Keep dev server running after tests
  pnpm test --help             Show this help message

Environment variables:
  CLOUDFLARE_API_TOKEN         Cloudflare API token (optional for local dev)

The test suite will:
  1. Start wrangler dev server locally
  2. Wait for it to be responsive
  3. Run comprehensive API tests
  4. Report results and exit
`);
}

/**
 * Clean up and stop the dev server
 */
async function cleanupDevServer(devProcess: ChildProcess | null, keepAlive: boolean): Promise<void> {
  if (keepAlive && devProcess) {
    console.log("\n⏳ Keep-alive mode - server still running");
    console.log(`   Press Ctrl+C to stop`);
    // Keep process alive
    await new Promise(() => {});
    return;
  }
  
  if (!devProcess) return;
  
  console.log("\n🛑 Stopping dev server...");

  // Stop forwarding/destroy pipes so child stdio cannot keep Node alive.
  devProcess.stdout?.removeAllListeners("data");
  devProcess.stderr?.removeAllListeners("data");
  devProcess.stdout?.destroy();
  devProcess.stderr?.destroy();
  devProcess.stdin?.destroy();

  // Kill immediately. This is a detached process, so a negative PID kills the
  // whole process group, including pnpm/wrangler/workerd children.
  try {
    process.kill(-devProcess.pid!, "SIGKILL");
  } catch {
    devProcess.kill("SIGKILL");
  }

  // Do not wait for an exit event; let the test command exit immediately.
  devProcess.unref();
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  const { help, ui, keepAlive } = parseArgs();

  if (help) {
    printHelp();
    process.exit(0);
  }

  console.log("🎯 Clawflare E2E Test Suite");
  console.log("=".repeat(60));

  let devProcess: ChildProcess | null = null;
  let serverPort = 0;

  try {
    // Start local dev server
    const { process: proc, url, port } = await deployLocal();
    devProcess = proc;
    serverPort = port;

    if (ui) {
      // Manual testing mode
      await runManualTesting(url, TEST_TOKEN);
    } else {
      // Automated testing mode
      await runTests(url, TEST_TOKEN);
    }
  } catch (error) {
    console.error("\n❌ Fatal error:", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    await cleanupDevServer(devProcess, keepAlive);
    // Exit immediately to prevent hanging
    if (!keepAlive) {
      process.exit(process.exitCode || 0);
    }
  }
}

main();
