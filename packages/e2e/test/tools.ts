import type { E2ETestContext, E2ETestRunner } from "./support.js";

export async function runToolTests(runner: E2ETestRunner, ctx: E2ETestContext): Promise<void> {
  const { client } = ctx;

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

  await runner.runTest("execute_code runs inline Dynamic Worker code", async () => {
    const sessionId = await ctx.createToolSession();
    const data = await ctx.invokeTool<{ ok?: boolean }>("execute_code", {
      code: "export default async function(input, env) { return { message: 'ok', input }; }",
      input: { value: 42 },
    }, sessionId);
    const text = data.result.content[0]?.text ?? "";
    if (!data.result.details.ok || !text.includes('"message": "ok"') || !text.includes('"value": 42')) {
      throw new Error(`Unexpected execute_code result: ${JSON.stringify(data)}`);
    }
  });

  await runner.runTest("store/search/execute stored code", async () => {
    const sessionId = await ctx.createToolSession();
    await ctx.invokeTool("store_code", {
      name: "double_number",
      description: "Doubles a numeric input",
      code: "export default async function(input, env) { return input.value * 2; }",
    }, sessionId);

    const search = await ctx.invokeTool<{
      storedCode: Array<{ name: string; code?: string }>;
    }>("search", {
      collection: "stored_code",
      query: "double",
    }, sessionId);
    const found = search.result.details.storedCode.find((item) => item.name === "double_number");
    if (!found) throw new Error(`Stored code not found: ${JSON.stringify(search)}`);
    if (found.code) throw new Error("Search should not return stored code body");

    const executed = await ctx.invokeTool<{ ok?: boolean }>("execute_stored_code", {
      name: "double_number",
      input: { value: 21 },
    }, sessionId);
    const executedText = executed.result.content[0]?.text ?? "";
    if (!executed.result.details.ok || !executedText.includes("Result: 42")) {
      throw new Error(`Unexpected execute_stored_code result: ${JSON.stringify(executed)}`);
    }
  });
}
