import type { E2ETestContext, E2ETestRunner } from "./support.js";

export async function runAuthTests(runner: E2ETestRunner, ctx: E2ETestContext): Promise<void> {
  const { url, token } = ctx;

  await runner.runTest("Unauthorized - missing auth header", async () => {
    const response = await fetch(`${url}/v1/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "hello" }),
    });
    if (response.status !== 401) throw new Error(`Expected 401, got ${response.status}`);
  });

  await runner.runTest("Unauthorized - wrong token", async () => {
    const response = await fetch(`${url}/v1/chat`, {
      method: "POST",
      headers: { Authorization: "Bearer wrong-token", "Content-Type": "application/json" },
      body: JSON.stringify({ content: "hello" }),
    });
    if (response.status !== 401) throw new Error(`Expected 401, got ${response.status}`);
  });

  await runner.runTest("Authorized - valid token", async () => {
    const response = await fetch(`${url}/v1/chat`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ content: "hello" }),
    });
    if (response.status === 401) throw new Error("Valid token was rejected");
  });
}
