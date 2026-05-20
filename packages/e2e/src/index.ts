/**
 * Remote E2E Tests for Clawflare.
 *
 * The suite deploys a brand-new Cloudflare Worker test instance, runs API tests
 * against the workers.dev URL, then deletes the Worker.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { resolve as pathResolve } from "node:path";
import { AgentClient } from "@clawflare/cli";

const TEST_TOKEN = "test-token-12345";
const HARNESS_DIR = pathResolve(process.cwd(), "..", "harness");
const CF_API_TOKEN = process.env.CF_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN || "";

interface RemoteDeployment {
  workerName: string;
  url: string;
  configPath: string;
  d1Name: string;
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

function runWrangler(args: string[], options: { capture?: boolean } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("pnpm", ["exec", "wrangler", ...args], {
      cwd: HARNESS_DIR,
      stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
      env: {
        ...process.env,
        ...(CF_API_TOKEN ? { CLOUDFLARE_API_TOKEN: CF_API_TOKEN } : {}),
      },
    });

    let stdout = "";
    let stderr = "";

    if (options.capture) {
      proc.stdout?.on("data", (data) => {
        const text = data.toString();
        stdout += text;
        process.stdout.write(text);
      });
      proc.stderr?.on("data", (data) => {
        const text = data.toString();
        stderr += text;
        process.stderr.write(text);
      });
    }

    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`wrangler ${args.join(" ")} exited with code ${code}. ${stderr}`));
      }
    });
  });
}

function extractD1DatabaseId(output: string): string {
  const hclMatch = output.match(/database_id\s*=\s*"([^"]+)"/);
  if (hclMatch?.[1]) return hclMatch[1];
  const jsonMatch = output.match(/"database_id"\s*:\s*"([^"]+)"/);
  if (jsonMatch?.[1]) return jsonMatch[1];
  const uuidMatch = output.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (uuidMatch?.[0]) return uuidMatch[0];
  throw new Error(`Could not find D1 database_id in wrangler output: ${output}`);
}

function extractWorkerUrl(output: string, workerName: string): string {
  const urls = output.match(/https:\/\/[^\s]+\.workers\.dev/g) || [];
  const preferred = urls.find((url) => url.includes(workerName));
  const url = preferred || urls[0];
  if (!url) throw new Error(`Could not find workers.dev URL in wrangler deploy output: ${output}`);
  return url.replace(/\/+$/, "");
}

async function writeTestConfig(workerName: string, workflowName: string, d1Name: string, d1DatabaseId: string): Promise<string> {
  const configPath = pathResolve(HARNESS_DIR, `wrangler.e2e.${workerName}.jsonc`);
  const config = {
    $schema: "./node_modules/wrangler/config-schema.json",
    name: workerName,
    compatibility_date: "2025-01-01",
    compatibility_flags: ["nodejs_compat"],
    main: "src/e2e-entry.ts",
    minify: false,
    define: {
      "process.env.NODE_ENV": "\"test\"",
      __DEV__: "true",
    },
    services: [{ binding: "HTTP_GATEWAY", service: workerName, entrypoint: "HttpGateway" }],
    worker_loaders: [{ binding: "LOADER" }],
    d1_databases: [
      {
        binding: "DB",
        database_name: d1Name,
        database_id: d1DatabaseId,
        migrations_dir: "migrations",
      },
    ],
    durable_objects: {
      bindings: [{ name: "WEBSOCKET_SESSION", class_name: "ClawflareWebSocketSession" }],
    },
    // E2E deploys a brand-new Worker, so only declare currently bound DO
    // classes. Legacy production migration history is intentionally not used
    // here because delete-class migrations require a previously deployed script
    // version that exported the deleted class.
    migrations: [{ tag: "v1", new_classes: ["ClawflareWebSocketSession"] }],
    workflows: [{ name: workflowName, binding: "AGENT_WORKFLOW", class_name: "PersistentSessionWorkflow" }],
    vars: {
      AI_PROVIDER: "amazon-bedrock",
      AI_MODEL: "minimax.minimax-m2.5",
      MOCK_AI: "true",
      CLAWFLARE_API_TOKEN: TEST_TOKEN,
      CLOUDFLARE_API_TOKEN: "e2e-mock-token",
      CLAWFLARE_TEST_RUN: "true",
    },
  };

  await writeFile(configPath, JSON.stringify(config, null, 2));
  return configPath;
}

async function deployRemote(): Promise<RemoteDeployment> {
  const runId = randomUUID().slice(0, 8);
  const workerName = `clawflare-harness-e2e-${runId}`;
  const workflowName = `clawflare-agent-workflow-e2e-${runId}`;
  const d1Name = `clawflare-e2e-${runId}`;
  let configPath = "";

  console.log("🚀 Creating remote E2E deployment...");
  console.log(`   Worker: ${workerName}`);
  console.log(`   Workflow: ${workflowName}`);
  console.log(`   D1: ${d1Name}`);

  try {
    const d1Output = await runWrangler(["d1", "create", d1Name], { capture: true });
    const d1DatabaseId = extractD1DatabaseId(d1Output);
    configPath = await writeTestConfig(workerName, workflowName, d1Name, d1DatabaseId);
    await runWrangler(["d1", "migrations", "apply", d1Name, "--remote", "--config", configPath]);

    const deployOutput = await runWrangler(
      [
        "deploy",
        "--config",
        configPath,
        "--tag",
        "e2e",
        "--message",
        `Clawflare E2E test deployment ${runId}`,
      ],
      { capture: true }
    );
    const url = extractWorkerUrl(deployOutput, workerName);

    console.log(`\n✅ Remote test Worker deployed: ${url}\n`);
    return { workerName, url, configPath, d1Name };
  } catch (error) {
    await runWrangler(["delete", workerName, "--force"]).catch(() => undefined);
    await runWrangler(["d1", "delete", d1Name, "--skip-confirmation"]).catch(() => undefined);
    if (configPath) {
      await rm(configPath, { force: true }).catch(() => undefined);
    }
    throw error;
  }
}

async function waitForServer(url: string, maxAttempts = 60): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const response = await fetch(`${url}/health`, { method: "GET" });
      if (response.ok) return true;
    } catch {
      // Remote route may not be propagated yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

async function runTests(url: string, token: string): Promise<void> {
  const runner = new TestRunner();
  const client = new AgentClient(url, token);

  console.log("🧪 Starting remote E2E Tests");
  console.log(`   Target: ${url}`);
  console.log(`   Token: ${token.substring(0, 10)}...`);

  const ready = await waitForServer(url);
  if (!ready) throw new Error("Remote Worker failed to become responsive");
  console.log("✅ Remote Worker is responsive\n");

  await runner.runTest("Health check - unauthenticated", async () => {
    const response = await fetch(`${url}/health`);
    if (!response.ok) throw new Error(`Expected OK, got ${response.status}`);
    const data = await response.json() as { status?: string };
    if (data.status !== "ok") throw new Error(`Expected status ok, got ${JSON.stringify(data)}`);
  });

  await runner.runTest("Unauthorized - missing auth header", async () => {
    const response = await fetch(`${url}/v1/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "prompt", content: "hello" }),
    });
    if (response.status !== 401) throw new Error(`Expected 401, got ${response.status}`);
  });

  await runner.runTest("Unauthorized - wrong token", async () => {
    const response = await fetch(`${url}/v1/chat`, {
      method: "POST",
      headers: { Authorization: "Bearer wrong-token", "Content-Type": "application/json" },
      body: JSON.stringify({ type: "prompt", content: "hello" }),
    });
    if (response.status !== 401) throw new Error(`Expected 401, got ${response.status}`);
  });

  await runner.runTest("Authorized - valid token", async () => {
    const response = await fetch(`${url}/v1/chat`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ type: "prompt", content: "hello" }),
    });
    if (response.status === 401) throw new Error("Valid token was rejected");
  });

  await runner.runTest("Get context - authorized", async () => {
    const context = await client.getContext();
    if (!context.id) throw new Error("Context missing ID");
    if (!Array.isArray(context.messages)) throw new Error("Context messages not an array");
  });

  await runner.runTest("Create new context", async () => {
    const oldContextId = client.getCurrentContextId();
    const context = await client.createContext();
    if (!context.id) throw new Error("New context missing ID");
    if (context.id === oldContextId) throw new Error("New context has same ID as old context");
  });

  await runner.runTest("Create context with parent", async () => {
    const parentContext = await client.createContext();
    const childContext = await client.createContext(parentContext.id);
    if (childContext.parentId !== parentContext.id) {
      throw new Error(`Expected parentId ${parentContext.id}, got ${childContext.parentId}`);
    }
  });

  await runner.runTest("Simple prompt", async () => {
    const submitted = await client.submitChat({ type: "prompt", content: "Say 'hello'" });
    // Poll until complete
    for await (const update of client.streamSession(submitted.sessionId)) {
      if (update.complete) {
        if (update.session.status === "error") {
          throw new Error(`Session failed: ${update.session.errorMessage}`);
        }
        // Wait a bit for messages to sync
        await new Promise(r => setTimeout(r, 500));
        // Re-fetch session to get latest messages
        const refreshed = await client.getSession(submitted.sessionId);
        const lastMsg = refreshed.messages.at(-1);
        if (!lastMsg || lastMsg.role !== "assistant") {
          throw new Error("Expected assistant response");
        }
        return;
      }
    }
    throw new Error("Session did not complete");
  });

  await runner.runTest("Session history preserved", async () => {
    // Create a new context to ensure we don't reuse the Simple prompt session
    await client.createContext();
    
    // First message
    const submitted1 = await client.submitChat({ type: "prompt", content: `First message: test-${Date.now()}` });
    let firstResponse = "";
    for await (const update of client.streamSession(submitted1.sessionId)) {
      if (update.complete) {
        const lastMsg = update.session.messages.at(-1);
        if (lastMsg?.role === "assistant") {
          const content = typeof lastMsg.content === "string" ? lastMsg.content : lastMsg.content.filter(c => c.type === "text").map(c => c.text).join("");
          firstResponse = content;
        }
        break;
      }
    }
    
    if (!firstResponse) {
      throw new Error(`First message failed - no response`);
    }
    console.error(`First response: ${firstResponse.substring(0, 60)}...`);
    
    // Wait extra time for workflow to fully complete and sync
    await new Promise(r => setTimeout(r, 1000));
    
    // Second message using same session
    const submitted2 = await client.submitChat({ type: "prompt", content: "HISTORY_TEST: What messages have I sent?", sessionId: submitted1.sessionId });
    console.error(`Second submit returned sessionId: ${submitted2.sessionId}`);
    
    let secondResponse = "";
    for await (const update of client.streamSession(submitted2.sessionId)) {
      console.error(`Polling second: status=${update.session.status}, messages=${update.session.messages.length}`);
      if (update.complete) {
        // Extra wait for sync
        await new Promise(r => setTimeout(r, 500));
        const refreshed = await client.getSession(submitted2.sessionId);
        console.error(`Second complete: refreshed messages=${refreshed.messages.length}`);
        const lastMsg = refreshed.messages.at(-1);
        if (lastMsg?.role === "assistant") {
          const content = typeof lastMsg.content === "string" ? lastMsg.content : lastMsg.content.filter(c => c.type === "text").map(c => c.text).join("");
          secondResponse = content;
        }
        break;
      }
    }
    
    if (!secondResponse) {
      throw new Error(`Second message failed - no response`);
    }
    console.error(`Second response: ${secondResponse.substring(0, 100)}...`);
    
    if (!secondResponse.includes("HISTORY_TEST_MODE")) {
      throw new Error(`Expected HISTORY_TEST_MODE in response, got: ${secondResponse}`);
    }
  });

  await runner.runTest("Fork context", async () => {
    const context = await client.createContext();
    const originalId = context.id;
    const newContext = await client.forkContext();
    if (!newContext.id) throw new Error("Fork failed - no context ID returned");
    if (newContext.id === originalId) throw new Error("Fork returned same context ID");
  });

  await runner.runTest("Chat rejects steer messages", async () => {
    const response = await fetch(`${url}/v1/chat`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ type: "steer", content: "Be more helpful" }),
    });
    if (response.status !== 400) throw new Error(`Expected 400, got ${response.status}`);
  });

  await runner.runTest("List tools", async () => {
    const tools = await client.listTools();
    const toolNames = tools.map((tool) => tool.name).sort();
    const expectedTools = ["execute_code", "execute_stored_code", "search", "store_code"].sort();
    if (JSON.stringify(toolNames) !== JSON.stringify(expectedTools)) {
      throw new Error(`Expected tools ${JSON.stringify(expectedTools)}, got ${JSON.stringify(toolNames)}`);
    }
  });

  await runner.runTest("Skills endpoint removed", async () => {
    const response = await fetch(`${url}/v1/skills`, { headers: { Authorization: `Bearer ${token}` } });
    if (response.status !== 404) throw new Error(`Expected 404, got ${response.status}`);
  });

  await runner.runTest("execute_code runs inline Dynamic Worker code", async () => {
    const response = await fetch(`${url}/__test/execute-code`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ code: "return { message: 'ok', input };", input: { value: 42 } }),
    });
    const data = await response.json() as { ok: boolean; result?: { message?: string; input?: { value?: number } } };
    if (!data.ok || data.result?.message !== "ok" || data.result?.input?.value !== 42) {
      throw new Error(`Unexpected execute_code result: ${JSON.stringify(data)}`);
    }
  });

  await runner.runTest("store/search/execute stored code", async () => {
    const storeResponse = await fetch(`${url}/__test/store-code`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "double_number", description: "Doubles a numeric input", code: "return input.value * 2;" }),
    });
    const stored = await storeResponse.json() as { ok: boolean };
    if (!stored.ok) throw new Error(`store_code failed: ${JSON.stringify(stored)}`);

    const searchResponse = await fetch(`${url}/__test/search?collection=stored_code&q=double`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const search = await searchResponse.json() as { results?: { storedCode: Array<{ name: string; code?: string }> } };
    const found = search.results?.storedCode.find((item) => item.name === "double_number");
    if (!found) throw new Error(`Stored code not found: ${JSON.stringify(search)}`);
    if (found.code) throw new Error("Search should not return stored code body");

    const executeResponse = await fetch(`${url}/__test/execute-stored-code`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "double_number", input: { value: 21 } }),
    });
    const executed = await executeResponse.json() as { ok: boolean; result?: number };
    if (!executed.ok || executed.result !== 42) {
      throw new Error(`Unexpected execute_stored_code result: ${JSON.stringify(executed)}`);
    }
  });

  await runner.runTest("search finds GitHub and Cloudflare egress handlers", async () => {
    for (const [query, name] of [["api.github.com", "github"], ["api.cloudflare.com", "cloudflare"]] as const) {
      const response = await fetch(`${url}/__test/search?collection=egress_handlers&q=${query}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await response.json() as { results?: { egressHandlers: Array<{ name: string }> } };
      if (!data.results?.egressHandlers.some((handler) => handler.name === name)) {
        throw new Error(`${name} handler not found: ${JSON.stringify(data)}`);
      }
    }
  });

  await runner.runTest("search egress with * wildcard lists all handlers", async () => {
    const response = await fetch(`${url}/__test/search?collection=egress_handlers&q=*`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await response.json() as { results?: { egressHandlers: Array<{ name: string }> } };
    const names = data.results?.egressHandlers.map((h) => h.name).sort();
    if (!names || names.length < 2) {
      throw new Error(`Expected at least 2 handlers, got: ${JSON.stringify(names)}`);
    }
    if (!names.includes("github") || !names.includes("cloudflare")) {
      throw new Error(`Expected github and cloudflare handlers, got: ${JSON.stringify(names)}`);
    }
  });

  await runner.runTest("search egress with wildcard prefix finds matching domains", async () => {
    const response = await fetch(`${url}/__test/search?collection=egress_handlers&q=*github.com`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await response.json() as { results?: { egressHandlers: Array<{ name: string }> } };
    const names = data.results?.egressHandlers.map((h) => h.name);
    if (!names?.includes("github")) {
      throw new Error(`Expected github handler, got: ${JSON.stringify(names)}`);
    }
  });

  await runner.runTest("generic egress is allowed", async () => {
    const response = await fetch(`${url}/__test/execute-code`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        code: "const response = await fetch('https://example.com'); return { status: response.status, body: await response.text() };",
      }),
    });
    const data = await response.json() as { ok: boolean; result?: { status?: number; body?: string } };
    if (!data.ok || data.result?.status !== 200 || !data.result.body?.includes("Example Domain")) {
      throw new Error(`Expected generic egress to be allowed, got: ${JSON.stringify(data)}`);
    }
  });

  await runner.runTest("execute_code can fetch through Cloudflare egress handler", async () => {
    const response = await fetch(`${url}/__test/execute-code`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        code: "const response = await fetch('https://api.cloudflare.com/client/v4/accounts'); return { status: response.status, body: await response.json() };",
      }),
    });
    const data = await response.json() as { ok: boolean; result?: { status?: number; body?: { handler?: string } }; error?: string };
    if (!data.ok || data.result?.status !== 200 || data.result?.body?.handler !== "cloudflare") {
      throw new Error(`Expected Dynamic Worker Cloudflare egress delegation, got: ${JSON.stringify(data)}`);
    }
  });

  await runner.runTest("gateway delegates matching egress handler", async () => {
    const response = await fetch(`${url}/__test/egress-fetch`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://api.github.com" }),
    });
    const data = await response.json() as { ok: boolean; status?: number; body?: { handler?: string } };
    if (!data.ok || data.status !== 200 || data.body?.handler !== "github") {
      throw new Error(`Expected GitHub egress handler delegation, got: ${JSON.stringify(data)}`);
    }
  });

  await runner.runTest("Session API: submit and poll for completion", async () => {
    const startResponse = await fetch(`${url}/v1/chat`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ type: "prompt", content: "session smoke test" }),
    });
    const submitted = await startResponse.json() as { sessionId?: string; eventCursor?: string };
    if (!submitted.sessionId || !submitted.eventCursor) throw new Error(`Session did not start: ${JSON.stringify(submitted)}`);

    let lastStatus = "";
    for (let i = 0; i < 30; i++) {
      const sessionResponse = await fetch(`${url}/v1/session/${submitted.sessionId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const session = await sessionResponse.json() as { status?: string; errorMessage?: string };
      lastStatus = JSON.stringify(session);
      if (session.status === "idle") return;
      if (session.status === "error") throw new Error(`Session errored: ${lastStatus}`);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error(`Session did not complete: ${lastStatus}`);
  });

  await runner.runTest("WebSocket starts workflow and streams final response", async () => {
    const ws = await client.connectWebSocket();
    try {
      const result = await new Promise<{ type?: string; content?: string }>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Timed out waiting for WebSocket workflow response")), 120000);

        ws.on("message", (data) => {
          const message = JSON.parse(data.toString()) as { type?: string; content?: string; status?: string };
          if (message.type === "error") {
            clearTimeout(timeout);
            reject(new Error(message.content || "WebSocket returned error"));
            return;
          }
          if (message.type === "message") {
            clearTimeout(timeout);
            resolve(message);
          }
        });
        ws.on("error", (error) => {
          clearTimeout(timeout);
          reject(error);
        });

        ws.send(JSON.stringify({ type: "prompt", content: "websocket workflow smoke test" }));
      });

      if (result.type !== "message" || !result.content) {
        throw new Error(`Unexpected WebSocket result: ${JSON.stringify(result)}`);
      }
    } finally {
      ws.close();
    }
  });

  await runner.runTest("404 on unknown endpoint", async () => {
    const response = await fetch(`${url}/unknown-endpoint`, { headers: { Authorization: `Bearer ${token}` } });
    if (response.status !== 404) throw new Error(`Expected 404, got ${response.status}`);
  });

  runner.printSummary();
}

async function runManualTesting(url: string, token: string): Promise<void> {
  console.log("\n🎨 Launching TUI for manual testing...");
  console.log(`   URL: ${url}`);
  console.log(`   Token: ${token}`);
  console.log("\n   Press Ctrl+C to exit. The remote Worker is deleted when this process exits.\n");

  const { runCli } = await import("@clawflare/cli");
  await runCli(url, token);
}

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
Clawflare Remote E2E Tests

Usage:
  pnpm test                    Deploy remote test Worker, run tests, tear down
  pnpm test --ui               Deploy remote test Worker and launch TUI
  pnpm test --keep-alive       Keep remote test Worker after tests
  pnpm test --help             Show help

Environment variables:
  CLOUDFLARE_API_TOKEN or CF_API_TOKEN  Wrangler authentication token

The test suite will:
  1. Deploy a unique remote Worker named clawflare-harness-e2e-<id>
  2. Tag the Worker version as e2e
  3. Run API tests against the workers.dev URL
  4. Delete the Worker and temp config unless --keep-alive is used
`);
}

async function cleanupRemoteDeployment(deployment: RemoteDeployment | null, keepAlive: boolean): Promise<void> {
  if (!deployment) return;

  if (keepAlive) {
    console.log("\n⏳ Keep-alive mode - remote test resources were not deleted");
    console.log(`   Worker: ${deployment.workerName}`);
    console.log(`   URL: ${deployment.url}`);
    console.log(`   Config: ${deployment.configPath}`);
    return;
  }

  console.log("\n🧹 Tearing down remote E2E resources...");

  try {
    await runWrangler(["delete", deployment.workerName, "--force"]);
  } catch (error) {
    console.error(`   Failed to delete Worker ${deployment.workerName}:`, error instanceof Error ? error.message : String(error));
  }

  try {
    await runWrangler(["d1", "delete", deployment.d1Name, "--skip-confirmation"]);
  } catch (error) {
    console.error(`   Failed to delete D1 database ${deployment.d1Name}:`, error instanceof Error ? error.message : String(error));
  }

  try {
    await rm(deployment.configPath, { force: true });
  } catch {
    // Ignore temp config cleanup failure.
  }
}

async function main(): Promise<void> {
  const { help, ui, keepAlive } = parseArgs();

  if (help) {
    printHelp();
    process.exit(0);
  }

  console.log("🎯 Clawflare Remote E2E Test Suite");
  console.log("=".repeat(60));

  let deployment: RemoteDeployment | null = null;

  try {
    deployment = await deployRemote();

    if (ui) {
      await runManualTesting(deployment.url, TEST_TOKEN);
    } else {
      await runTests(deployment.url, TEST_TOKEN);
    }
  } catch (error) {
    console.error("\n❌ Fatal error:", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    await cleanupRemoteDeployment(deployment, keepAlive);
    if (!keepAlive) process.exit(process.exitCode || 0);
  }
}

main();
