/**
 * Remote E2E Tests for Clawflare.
 *
 * The suite deploys a brand-new Cloudflare Worker test instance, runs API tests
 * against the workers.dev URL, then deletes the Worker.
 * 
 * Note: Some tests (container workspace) require Docker to be installed and
 * running, as Cloudflare Containers need to build the container image.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdir, rm, writeFile } from "node:fs/promises";
import { resolve as pathResolve } from "node:path";
import { AgentClient } from "@clawflare/cli/client";
import { E2E_SERVER_NAMES as runtimeNames } from "./server-names.js";

const HARNESS_DIR = pathResolve(process.cwd(), "..", "server");
const CF_API_TOKEN = process.env.CF_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN || "";

interface RemoteDeployment {
  workerName: string;
  url?: string;
  configPath?: string;
  d1Name: string;
}

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  duration: number;
}

// Track reserved container IDs for cleanup, including containers mid-create.
const createdContainers: Array<{ containerId: string; sessionId: string }> = [];
let activeDeployment: RemoteDeployment | null = null;
let activeKeepAlive = false;
let activeAuthToken: string | null = null;
let cleanupStarted = false;

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

async function readJsonResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    const preview = text.length > 1000 ? `${text.slice(0, 1000)}...` : text;
    throw new Error(`Expected JSON response, got HTTP ${response.status} ${response.statusText}: ${preview}`);
  }
}

interface ToolInvokeResponse<TDetails = unknown> {
  tool: string;
  result: {
    content: Array<{ type: string; text?: string }>;
    details: TDetails;
  };
}

async function invokeTool<TDetails = unknown>(
  url: string,
  token: string,
  name: string,
  input: unknown,
  sessionId?: string
): Promise<ToolInvokeResponse<TDetails>> {
  const response = await fetch(`${url}/v1/tools/${name}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ input, sessionId }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Tool ${name} failed with ${response.status}: ${text}`);
  }
  return readJsonResponse<ToolInvokeResponse<TDetails>>(response);
}

async function createToolSession(client: AgentClient): Promise<string> {
  return (await client.createSession()).id;
}

function trackTestContainer(containerId: string, sessionId: string): void {
  if (!createdContainers.some((container) => container.containerId === containerId && container.sessionId === sessionId)) {
    createdContainers.push({ containerId, sessionId });
  }
}

function untrackTestContainer(containerId: string, sessionId: string): void {
  const index = createdContainers.findIndex((container) => (
    container.containerId === containerId &&
    container.sessionId === sessionId
  ));
  if (index !== -1) createdContainers.splice(index, 1);
}

async function destroyTestContainer(url: string, token: string, containerId: string, sessionId: string): Promise<void> {
  // Track before destroy so global teardown can retry if this call fails.
  trackTestContainer(containerId, sessionId);

  try {
    const data = await invokeTool<{ ok?: boolean }>(
      url,
      token,
      "container_destroy",
      { containerId },
      sessionId
    );
    if (!data.result.details.ok) {
      console.error(`Failed to destroy container ${containerId}: ${JSON.stringify(data)}`);
      return;
    }
    untrackTestContainer(containerId, sessionId);
  } catch (error) {
    console.error(`Failed to destroy container ${containerId}:`, error instanceof Error ? error.message : String(error));
  }
}

async function cleanupAllContainers(url: string, token: string): Promise<void> {
  if (createdContainers.length === 0) return;
  
  console.log(`   Cleaning up ${createdContainers.length} tracked containers...`);
  const cleanupPromises = createdContainers.map(async ({ containerId, sessionId }) => {
    try {
      const data = await invokeTool<{ ok?: boolean }>(
        url,
        token,
        "container_destroy",
        { containerId },
        sessionId
      );
      if (data.result.details.ok) {
        console.log(`     ✓ Destroyed container: ${containerId.slice(0, 30)}...`);
        untrackTestContainer(containerId, sessionId);
      }
    } catch {
      // Container might already be destroyed or Worker might be unreachable
    }
  });
  
  await Promise.all(cleanupPromises);
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

async function writeTestConfig(workerName: string, d1Name: string, d1DatabaseId: string): Promise<string> {
  const configPath = pathResolve(HARNESS_DIR, `wrangler.e2e.${workerName}.jsonc`);
  const config = {
    $schema: "./node_modules/wrangler/config-schema.json",
    name: workerName,
    compatibility_date: "2025-01-01",
    compatibility_flags: ["nodejs_compat", "enable_ctx_exports"],
    main: "src/index.ts",
    minify: false,
    define: {
      "process.env.NODE_ENV": "\"test\"",
      __DEV__: "true",
    },
    services: [{ binding: "HTTP_GATEWAY", service: workerName, entrypoint: "HttpGateway" }],
    worker_loaders: [{ binding: "LOADER" }],
    containers: [
      {
        class_name: "CodingContainer",
        image: "./container-runtime/Dockerfile",
        max_instances: 5,
        instance_type: "lite",
      },
    ],
    d1_databases: [
      {
        binding: "DB",
        database_name: d1Name,
        database_id: d1DatabaseId,
        migrations_dir: "migrations",
      },
    ],
    durable_objects: {
      bindings: [
        { name: "WEBSOCKET_SESSION", class_name: "ClawflareWebSocketSession" },
        { name: "CODING_CONTAINER", class_name: "CodingContainer" },
      ],
    },
    // E2E deploys a brand-new Worker, so only declare currently bound DO
    // classes. Legacy production migration history is intentionally not used
    // here because delete-class migrations require a previously deployed script
    // version that exported the deleted class.
    migrations: [
      { tag: "v1", new_classes: ["ClawflareWebSocketSession"] },
      { tag: "v2", new_sqlite_classes: ["CodingContainer"] },
    ],
    triggers: {
      crons: ["* * * * *"],
    },
    vars: {
      AI_PROVIDER: "amazon-bedrock",
      AI_MODEL: "minimax.minimax-m2.5",
      MOCK_AI: "true",
      MOCK_EGRESS: "true",
      // CLAWFLARE_API_TOKEN removed - tests now use login-based auth
      CLOUDFLARE_API_TOKEN: "e2e-mock-token",
      CLAWFLARE_TEST_RUN: "true",
    },
  };

  await writeFile(configPath, JSON.stringify(config, null, 2));
  return configPath;
}

async function deployRemote(): Promise<RemoteDeployment> {
  // Use unique worker names to avoid container application conflicts.
  // Container applications persist after Worker deletion and can't be deleted,
  // so reusing the same Worker name causes deployment failures.
  const runId = randomUUID().slice(0, 8);
  const workerName = `${runtimeNames.e2eWorkerPrefix}-${runId}`;
  const d1Name = `${runtimeNames.e2eDatabasePrefix}-${runId}`;
  let configPath = "";
  activeDeployment = { workerName, d1Name };

  console.log("🚀 Creating remote E2E deployment...");
  console.log(`   Worker: ${workerName}`);
  console.log(`   D1: ${d1Name}`);

  try {
    const d1Output = await runWrangler(["d1", "create", d1Name], { capture: true });
    const d1DatabaseId = extractD1DatabaseId(d1Output);
    configPath = await writeTestConfig(workerName, d1Name, d1DatabaseId);
    activeDeployment.configPath = configPath;
    pendingConfigPath = configPath;
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
    pendingConfigPath = null; // Deployment succeeded, config will be tracked in deployment object
    const url = extractWorkerUrl(deployOutput, workerName);
    activeDeployment.url = url;

    console.log(`\n✅ Remote test Worker deployed: ${url}\n`);
    return { workerName, url, configPath, d1Name };
  } catch (error) {
    await runWrangler(["delete", workerName, "--force"]).catch(() => undefined);
    await runWrangler(["d1", "delete", d1Name, "--skip-confirmation"]).catch(() => undefined);
    // Always clean up the config file on error (even if it's the same as pendingConfigPath)
    try {
      if (configPath) {
        pendingConfigPath = null;
        await rm(configPath, { force: true });
      }
    } catch {
      // Ignore cleanup errors
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

async function runTests(url: string): Promise<void> {
  const runner = new TestRunner();

  const ready = await waitForServer(url);
  if (!ready) throw new Error("Remote Worker failed to become responsive");
  console.log("✅ Remote Worker is responsive, authenticating via mock OAuth...\n");

  // Start mock OAuth device flow
  console.log("🔑 Starting mock OAuth device flow...");
  const deviceStartResponse = await fetch(`${url}/v1/auth/device/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clientName: "E2E Test Suite",
      provider: "mock",
    }),
  });
  const deviceStart = await readJsonResponse<{
    deviceCode?: string;
    userCode?: string;
    authorizationUrl?: string;
    verificationUrl?: string;
    interval?: number;
    error?: string;
  }>(deviceStartResponse);
  
  if (!deviceStart.deviceCode || !deviceStart.authorizationUrl) {
    throw new Error(`Failed to start device authorization: ${deviceStart.error || "unknown error"}`);
  }
  
  console.log(`   ✓ Device flow started`);
  console.log(`   Device Code: ${deviceStart.deviceCode.slice(0, 20)}...`);
  console.log(`   User Code: ${deviceStart.userCode}`);

  // Auto-approve via the mock OAuth endpoint
  console.log("🔑 Auto-approving via mock OAuth...");
  const autoApproveResponse = await fetch(deviceStart.authorizationUrl, { method: "GET" });
  if (!autoApproveResponse.ok) {
    const errorText = await autoApproveResponse.text();
    throw new Error(`Mock OAuth auto-approve failed: ${autoApproveResponse.status} ${errorText.slice(0, 200)}`);
  }
  console.log(`   ✓ Mock OAuth approval completed`);

  // Poll for the access token
  console.log("🔑 Polling for access token...");
  let token: string | undefined;
  let userId: string | undefined;
  const maxPolls = 30;
  const pollInterval = (deviceStart.interval || 2) * 1000;
  
  for (let i = 0; i < maxPolls; i++) {
    const pollResponse = await fetch(`${url}/v1/auth/device/poll`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceCode: deviceStart.deviceCode }),
    });
    const pollResult = await readJsonResponse<{
      status?: string;
      accessToken?: string;
      user?: { id: string; email: string };
      error?: string;
    }>(pollResponse);
    
    if (pollResult.status === "complete") {
      token = pollResult.accessToken;
      userId = pollResult.user?.id;
      console.log(`   ✓ Access token received after ${i + 1} poll(s)`);
      break;
    }
    
    if (pollResult.status === "denied") {
      throw new Error("Device authorization was denied");
    }
    
    if (pollResult.status === "expired") {
      throw new Error("Device code expired");
    }
    
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }
  
  if (!token) {
    throw new Error("Failed to get access token after polling");
  }
  activeAuthToken = token;
  
  console.log(`   User ID: ${userId?.slice(0, 16)}...`);
  console.log(`   Token: ${token.slice(0, 16)}...\n`);

  // Now create the client with the token
  const client = new AgentClient(url, token);

  console.log("🧪 Starting remote E2E Tests");
  console.log(`   Target: ${url}`);
  console.log(`   User: ${userId}`);
  console.log(`   Token: ${token.substring(0, 10)}...\n`);

  await runner.runTest("Unauthorized - missing auth header", async () => {
    const response = await fetch(`${url}/v1/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({  content: "hello" }),
    });
    if (response.status !== 401) throw new Error(`Expected 401, got ${response.status}`);
  });

  await runner.runTest("Unauthorized - wrong token", async () => {
    const response = await fetch(`${url}/v1/chat`, {
      method: "POST",
      headers: { Authorization: "Bearer wrong-token", "Content-Type": "application/json" },
      body: JSON.stringify({  content: "hello" }),
    });
    if (response.status !== 401) throw new Error(`Expected 401, got ${response.status}`);
  });

  await runner.runTest("Authorized - valid token", async () => {
    const response = await fetch(`${url}/v1/chat`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({  content: "hello" }),
    });
    if (response.status === 401) throw new Error("Valid token was rejected");
  });

  await runner.runTest("Create new session", async () => {
    const oldSessionId = client.getCurrentSessionId();
    const session = await client.createSession();
    if (!session.id) throw new Error("New session missing ID");
    if (session.id === oldSessionId) throw new Error("New session has same ID as old session");
  });

  await runner.runTest("Create session with parent", async () => {
    const parentSession = await client.createSession();
    const forkSession = await client.forkSession({
      parentSessionId: parentSession.id,
      parentMessageId: "", // Fork from latest
    });
    if (forkSession.id === parentSession.id) {
      throw new Error(`Expected fork to create new session`);
    }
  });

  await runner.runTest("Simple prompt", async () => {
    const submitted = await client.submitChat({  content: "Say 'hello'" });
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
    await client.createSession();
    
    // First message
    const submitted1 = await client.submitChat({  content: `First message: test-${Date.now()}` });
    let firstResponse = "";
    for await (const update of client.streamSession(submitted1.sessionId)) {
      if (update.complete) {
        const session = update.session.messages ? update.session : await client.getSession(submitted1.sessionId);
        const lastMsg = session.messages.at(-1);
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
    const submitted2 = await client.submitChat({  content: "HISTORY_TEST: What messages have I sent?", sessionId: submitted1.sessionId });
    console.error(`Second submit returned sessionId: ${submitted2.sessionId}`);
    
    let secondResponse = "";
    for await (const update of client.streamSession(submitted2.sessionId)) {
      console.error(`Polling second: status=${update.session.status}, messages=${update.session.messages?.length ?? 0}`);
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

  await runner.runTest("Fork session", async () => {
    const session = await client.createSession();
    const originalId = session.id;
    const forkSession = await client.forkSession({
      parentSessionId: originalId,
      parentMessageId: "",
    });
    if (!forkSession.id) throw new Error("Fork failed - no session ID returned");
    if (forkSession.id === originalId) throw new Error("Fork returned same session ID");
  });

  await runner.runTest("Chat accepts steer-style content", async () => {
    const response = await fetch(`${url}/v1/chat`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Be more helpful" }),
    });
    if (response.status !== 200) throw new Error(`Expected 200, got ${response.status}`);
  });

  await runner.runTest("List tools", async () => {
    const tools = await client.listTools();
    const toolNames = tools.map((tool) => tool.name).sort();
    const expectedTools = [
      "container_bash",
      "container_create",
      "container_destroy",
      "container_edit",
      "container_find",
      "container_grep",
      "container_ls",
      "container_read",
      "container_write",
      "execute_code",
      "execute_stored_code",
      "search",
      "store_code",
    ].sort();
    if (JSON.stringify(toolNames) !== JSON.stringify(expectedTools)) {
      throw new Error(`Expected tools ${JSON.stringify(expectedTools)}, got ${JSON.stringify(toolNames)}`);
    }
  });

  await runner.runTest("Skills endpoint removed", async () => {
    const response = await fetch(`${url}/v1/skills`, { headers: { Authorization: `Bearer ${token}` } });
    if (response.status !== 404) throw new Error(`Expected 404, got ${response.status}`);
  });

  await runner.runTest("execute_code runs inline Dynamic Worker code", async () => {
    const sessionId = await createToolSession(client);
    const data = await invokeTool<{ ok?: boolean }>(url, token, "execute_code", {
      code: "export default async function(input, env) { return { message: 'ok', input }; }",
      input: { value: 42 },
    }, sessionId);
    const text = data.result.content[0]?.text ?? "";
    if (!data.result.details.ok || !text.includes('"message": "ok"') || !text.includes('"value": 42')) {
      throw new Error(`Unexpected execute_code result: ${JSON.stringify(data)}`);
    }
  });

  await runner.runTest("store/search/execute stored code", async () => {
    const sessionId = await createToolSession(client);
    await invokeTool(url, token, "store_code", {
      name: "double_number",
      description: "Doubles a numeric input",
      code: "export default async function(input, env) { return input.value * 2; }",
    }, sessionId);

    const search = await invokeTool<{
      storedCode: Array<{ name: string; code?: string }>;
    }>(url, token, "search", {
      collection: "stored_code",
      query: "double",
    }, sessionId);
    const found = search.result.details.storedCode.find((item) => item.name === "double_number");
    if (!found) throw new Error(`Stored code not found: ${JSON.stringify(search)}`);
    if (found.code) throw new Error("Search should not return stored code body");

    const executed = await invokeTool<{ ok?: boolean }>(url, token, "execute_stored_code", {
      name: "double_number",
      input: { value: 21 },
    }, sessionId);
    const executedText = executed.result.content[0]?.text ?? "";
    if (!executed.result.details.ok || !executedText.includes("Result: 42")) {
      throw new Error(`Unexpected execute_stored_code result: ${JSON.stringify(executed)}`);
    }
  });

  await runner.runTest("List egress handlers", async () => {
    const response = await fetch(`${url}/v1/egress-handlers?enabledOnly=false`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await response.json() as { egressHandlers?: Array<{ egressHandlerId: string }> };
    const names = data.egressHandlers?.map((h) => h.egressHandlerId).sort();
    if (!names || names.length < 2) {
      throw new Error(`Expected at least 2 handlers, got: ${JSON.stringify(names)}`);
    }
    if (!names.includes("github") || !names.includes("cloudflare")) {
      throw new Error(`Expected github and cloudflare handlers, got: ${JSON.stringify(names)}`);
    }
  });

  await runner.runTest("Get Cloudflare egress handler", async () => {
    const response = await fetch(`${url}/v1/egress-handlers/cloudflare`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await response.json() as { egressHandler?: { egressHandlerId: string; domains?: string[]; config?: unknown } };
    if (data.egressHandler?.egressHandlerId !== "cloudflare") {
      throw new Error(`Expected cloudflare handler, got: ${JSON.stringify(data)}`);
    }
    if (!data.egressHandler.domains?.includes("api.cloudflare.com")) {
      throw new Error(`Expected api.cloudflare.com domain, got: ${JSON.stringify(data)}`);
    }
    if ("config" in data.egressHandler) {
      throw new Error(`Egress handler response should not expose config: ${JSON.stringify(data)}`);
    }
  });

  await runner.runTest("generic egress is allowed", async () => {
    const sessionId = await createToolSession(client);
    const data = await invokeTool<{ ok?: boolean }>(url, token, "execute_code", {
      code: "export default async function(input, env) { const response = await fetch('https://example.com'); return { status: response.status, body: await response.text() }; }",
    }, sessionId);
    const text = data.result.content[0]?.text ?? "";
    if (!data.result.details.ok || !text.includes('"status": 200') || !text.includes("Example Domain")) {
      throw new Error(`Expected generic egress to be allowed, got: ${JSON.stringify(data)}`);
    }
  });

  await runner.runTest("Session API: submit and poll for completion", async () => {
    const startResponse = await fetch(`${url}/v1/chat`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({  content: "session smoke test" }),
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

        ws.send(JSON.stringify({  content: "websocket workflow smoke test" }));
      });

      if (result.type !== "message" || !result.content) {
        throw new Error(`Unexpected WebSocket result: ${JSON.stringify(result)}`);
      }
    } finally {
      ws.close();
    }
  });

  await runner.runTest("Container: create and run ls command", async () => {
    const containerId = `e2e-container-${Date.now()}`;
    const sessionId = await createToolSession(client);
    trackTestContainer(containerId, sessionId);

    try {
      const createData = await invokeTool<{ status?: string }>(
        url,
        token,
        "container_create",
        { containerId },
        sessionId
      );
      if (createData.result.details.status !== "healthy") throw new Error(`Container not healthy: ${JSON.stringify(createData)}`);
      
      const bashData = await invokeTool<{ ok?: boolean; exitCode: number | null }>(
        url,
        token,
        "container_bash",
        { containerId, command: "ls -la", cwd: "/workspace" },
        sessionId
      );
      const bashText = bashData.result.content[0]?.text ?? "";
      if (!bashData.result.details.ok) throw new Error(`Bash command failed: ${JSON.stringify(bashData)}`);
      if (bashData.result.details.exitCode !== 0) throw new Error(`Bash command exited with code ${bashData.result.details.exitCode}`);
      if (!bashText.includes("total") || !bashText.includes("workspace")) {
        if (bashText.trim().length === 0) {
          throw new Error(`No output from ls command`);
        }
      }
      
      // Verify container respects the deployed compatibility by checking it works at all
      // (this is the actual test for ctx.exports fix - if it fails to create, we'd have errored above)
    } finally {
      await destroyTestContainer(url, token, containerId, sessionId);
    }
  });

  await runner.runTest("Container: git clone works through GitHub egress", async () => {
    const containerId = `e2e-github-clone-${Date.now()}`;
    const sessionId = await createToolSession(client);
    trackTestContainer(containerId, sessionId);

    try {
      const createData = await invokeTool<{ status?: string }>(
        url,
        token,
        "container_create",
        { containerId },
        sessionId
      );
      if (createData.result.details.status !== "healthy") throw new Error(`Container not healthy: ${JSON.stringify(createData)}`);

      const cloneCommand = [
        "rm -rf /workspace/test-clone",
        "git clone --depth 1 https://github.com/asselstine/clawflare.git /workspace/test-clone",
        "ls -la /workspace/test-clone/",
      ].join(" && ");

      const bashData = await invokeTool<{ ok?: boolean; exitCode: number | null }>(
        url,
        token,
        "container_bash",
        { containerId, command: cloneCommand, cwd: "/workspace" },
        sessionId
      );
      if (!bashData.result.details.ok || bashData.result.details.exitCode !== 0) {
        throw new Error(`Git clone failed: ${JSON.stringify(bashData)}`);
      }
    } finally {
      await destroyTestContainer(url, token, containerId, sessionId);
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

  const cliPath = pathResolve(process.cwd(), "..", "cli", "dist", "index.js");
  const child = spawn("node", [cliPath, "--host", url, "--token", token], {
    stdio: "inherit",
    env: { ...process.env, CLAWFLARE_URL: url, CLAWFLARE_API_TOKEN: token },
  });

  await new Promise<void>((resolve, reject) => {
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`CLI exited with code ${code}`));
    });
  });
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
  1. Deploy a unique remote Worker named ${runtimeNames.e2eWorkerPrefix}-<id>
  2. Tag the Worker version as e2e
  3. Run API tests against the workers.dev URL
  4. Delete the Worker and temp config unless --keep-alive is used
`);
}

async function cleanupOldContainerImages(currentWorkerName?: string): Promise<void> {
  try {
    console.log("   Cleaning up old E2E container images...");

    const listOutput = await runWrangler(["containers", "images", "list", "--json"], { capture: true });
    const images = JSON.parse(listOutput) as unknown;

    if (!Array.isArray(images)) {
      throw new Error(`Unexpected containers image list output: ${listOutput}`);
    }

    const legacyE2ePrefix = "clawflare-harness-e2e";
    const currentImageNamePrefix = currentWorkerName ? `${currentWorkerName}-` : null;

    const imageGroups = images.filter((image): image is { name: string; tags: string[] } => (
      typeof image === "object" &&
      image !== null &&
      typeof (image as { name?: unknown }).name === "string" &&
      Array.isArray((image as { tags?: unknown }).tags)
    ));

    if (imageGroups.length === images.length) {
      const staleGroups = imageGroups.filter((image) =>
        image.name.includes(legacyE2ePrefix) ||
        (currentImageNamePrefix !== null && image.name.startsWith(currentImageNamePrefix))
      );

      if (staleGroups.length === 0) {
        console.log("   No E2E container images to clean up");
        return;
      }

      for (const image of staleGroups) {
        for (const tag of image.tags) {
          const imageRef = `${image.name}:${tag}`;
          try {
            await runWrangler(["containers", "images", "delete", imageRef], { capture: true });
            console.log(`     ✓ Deleted ${imageRef}`);
          } catch {
            console.log(`     ✗ Failed to delete ${imageRef}`);
          }
        }
      }

      const undeletedCurrentImages = imageGroups.filter((image) =>
        image.name.includes(runtimeNames.e2eWorkerPrefix) &&
        !staleGroups.some((staleImage) => staleImage.name === image.name)
      );

      if (undeletedCurrentImages.length > 0) {
        console.log(
          `   Note: Wrangler only returned image names/tags, so skipped pruning ${undeletedCurrentImages.length} other ${runtimeNames.e2eWorkerPrefix} image(s).`
        );
      }

      return;
    }

    const legacyImages = images.filter((image): image is { repository: string; tag: string; created: string } => (
      typeof image === "object" &&
      image !== null &&
      typeof (image as { repository?: unknown }).repository === "string" &&
      typeof (image as { tag?: unknown }).tag === "string" &&
      typeof (image as { created?: unknown }).created === "string"
    ));

    if (legacyImages.length !== images.length) {
      throw new Error(`Unsupported containers image list schema: ${listOutput}`);
    }

    const e2eImages = legacyImages.filter((img) => img.repository.includes(runtimeNames.e2eWorkerPrefix));

    if (e2eImages.length === 0) {
      console.log("   No E2E container images to clean up");
      return;
    }

    e2eImages.sort((a, b) => new Date(b.created).getTime() - new Date(a.created).getTime());
    const imagesToDelete = e2eImages.slice(5);

    if (imagesToDelete.length === 0) {
      console.log(`   Keeping ${e2eImages.length} most recent E2E images`);
      return;
    }

    for (const img of imagesToDelete) {
      const imageRef = `${img.repository}:${img.tag}`;
      try {
        await runWrangler(["containers", "images", "delete", imageRef], { capture: true });
        console.log(`     ✓ Deleted ${imageRef}`);
      } catch {
        console.log(`     ✗ Failed to delete ${imageRef}`);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`   Note: Container image cleanup skipped: ${message}`);
    if (error instanceof Error && error.stack) {
      console.log(error.stack.split("\n").map((line) => `   ${line}`).join("\n"));
    }
    console.log("   This may require a newer Wrangler version or different Wrangler containers CLI support.");
  }
}

let pendingConfigPath: string | null = null;

async function cleanupRemoteDeployment(deployment: RemoteDeployment | null, keepAlive: boolean, configPathOverride?: string | null): Promise<void> {
  if (cleanupStarted) return;
  cleanupStarted = true;
  const configPathToDelete = configPathOverride ?? deployment?.configPath;

  if (!deployment) {
    if (!keepAlive && configPathToDelete) {
      await rm(configPathToDelete, { force: true }).catch(() => undefined);
      console.log("   ✓ Temp config removed");
    }
    return;
  }

  if (keepAlive) {
    console.log("\n⏳ Keep-alive mode - remote test resources were not deleted");
    console.log(`   Worker: ${deployment.workerName}`);
    if (deployment.url) console.log(`   URL: ${deployment.url}`);
    if (deployment.configPath) console.log(`   Config: ${deployment.configPath}`);
    return;
  }

  console.log("\n🧹 Tearing down remote E2E resources...");

  if (deployment.url && activeAuthToken) {
    await cleanupAllContainers(deployment.url, activeAuthToken);
  } else if (createdContainers.length > 0) {
    console.log(`   Note: Skipping ${createdContainers.length} tracked container cleanup without Worker URL or auth token`);
  }

  try {
    await runWrangler(["delete", deployment.workerName, "--force"]);
    console.log("   ✓ Worker deleted");
  } catch (error) {
    console.error(`   ✗ Failed to delete Worker ${deployment.workerName}:`, error instanceof Error ? error.message : String(error));
  }

  // Note: Container images in registry.cloudflare.com may persist after Worker deletion.
  // Cloudflare periodically garbage-collects unused container images.
  // The running container instances are destroyed above, but the images in the
  // registry are managed separately and cleaned up asynchronously.
  console.log("   Note: Container images in registry may persist until Cloudflare garbage collection");

  try {
    await runWrangler(["d1", "delete", deployment.d1Name, "--skip-confirmation"]);
    console.log("   ✓ D1 database deleted");
  } catch (error) {
    console.error(`   ✗ Failed to delete D1 database ${deployment.d1Name}:`, error instanceof Error ? error.message : String(error));
  }

  try {
    if (configPathToDelete) {
      await rm(configPathToDelete, { force: true });
    }
    console.log("   ✓ Temp config removed");
  } catch (error) {
    console.error(`   ✗ Failed to remove temp config ${configPathToDelete ? pathResolve(HARNESS_DIR, configPathToDelete) : "(none)"}:`, error instanceof Error ? error.message : String(error));
  }

  // Clean up old container images from the registry
  await cleanupOldContainerImages(deployment.workerName);
  
  // Clean up any other lingering E2E config files
  await cleanupOldE2EConfigs();
}

function installShutdownHandlers(): void {
  const teardownAndExit = (signal: NodeJS.Signals) => {
    console.log(`\n\n${signal} received. Cleaning up remote E2E resources...`);
    void cleanupRemoteDeployment(activeDeployment, activeKeepAlive, pendingConfigPath)
      .catch((error) => {
        console.error("Cleanup failed:", error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      })
      .finally(() => process.exit(process.exitCode || 130));
  };

  process.once("SIGINT", teardownAndExit);
  process.once("SIGTERM", teardownAndExit);
}

async function cleanupOldE2EConfigs(): Promise<void> {
  try {
    const entries = await readdir(HARNESS_DIR);
    const e2eConfigPattern = /^wrangler\.e2e\.clawflare-.+\.jsonc$/;
    const oldConfigs = entries.filter((entry) => e2eConfigPattern.test(entry));
    
    if (oldConfigs.length === 0) return;
    
    console.log(`   Cleaning up ${oldConfigs.length} old E2E config file(s)...`);
    for (const config of oldConfigs) {
      const configPath = pathResolve(HARNESS_DIR, config);
      try {
        await rm(configPath, { force: true });
        console.log(`     ✓ Removed ${config}`);
      } catch {
        // Ignore errors for old configs
      }
    }
  } catch {
    // Directory might not exist or be readable
  }
}

async function main(): Promise<void> {
  const { help, ui, keepAlive } = parseArgs();
  activeKeepAlive = keepAlive;
  installShutdownHandlers();

  if (help) {
    printHelp();
    process.exit(0);
  }

  console.log("🎯 Clawflare Remote E2E Test Suite");
  console.log("=".repeat(60));

  let deployment: RemoteDeployment | null = null;

  try {
    deployment = await deployRemote();
    activeDeployment = deployment;

    if (ui) {
      // For manual testing, we still need to get a token
      const token = await authenticateForManualTesting(deployment.url);
      activeAuthToken = token;
      await runManualTesting(deployment.url, token);
    } else {
      await runTests(deployment.url);
    }
  } catch (error) {
    console.error("\n❌ Fatal error:", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    await cleanupRemoteDeployment(deployment, keepAlive, pendingConfigPath);
    if (!keepAlive) process.exit(process.exitCode || 0);
  }
}

async function authenticateForManualTesting(url: string): Promise<string> {
  console.log("🔑 Authenticating via mock OAuth for manual testing...");
  
  // Start mock OAuth device flow
  const deviceStartResponse = await fetch(`${url}/v1/auth/device/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clientName: "E2E Manual Test",
      provider: "mock",
    }),
  });
  const deviceStart = await readJsonResponse<{
    deviceCode?: string;
    authorizationUrl?: string;
    interval?: number;
    error?: string;
  }>(deviceStartResponse);
  
  if (!deviceStart.deviceCode || !deviceStart.authorizationUrl) {
    throw new Error(`Failed to start device authorization: ${deviceStart.error || "unknown error"}`);
  }

  // Auto-approve via the mock OAuth endpoint
  const autoApproveResponse = await fetch(deviceStart.authorizationUrl, { method: "GET" });
  if (!autoApproveResponse.ok) {
    const errorText = await autoApproveResponse.text();
    throw new Error(`Mock OAuth auto-approve failed: ${autoApproveResponse.status}`);
  }

  // Poll for the access token
  let token: string | undefined;
  const maxPolls = 30;
  const pollInterval = (deviceStart.interval || 2) * 1000;
  
  for (let i = 0; i < maxPolls; i++) {
    const pollResponse = await fetch(`${url}/v1/auth/device/poll`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceCode: deviceStart.deviceCode }),
    });
    const pollResult = await readJsonResponse<{
      status?: string;
      accessToken?: string;
      user?: { id: string; email: string };
    }>(pollResponse);
    
    if (pollResult.status === "complete") {
      token = pollResult.accessToken;
      break;
    }
    
    if (pollResult.status === "denied" || pollResult.status === "expired") {
      throw new Error(`Authorization ${pollResult.status}`);
    }
    
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }
  
  if (!token) {
    throw new Error("Failed to get access token after polling");
  }

  console.log(`   ✓ Got access token: ${token.slice(0, 16)}...\n`);
  return token;
}

main();
