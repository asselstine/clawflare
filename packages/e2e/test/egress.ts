import type { E2ETestContext, E2ETestRunner } from "./support.js";

interface EgressHandler {
  egressHandlerId: string;
  domains?: string[];
  enabled?: boolean;
  configuredSecrets?: string[];
  config?: unknown;
}

interface EgressListResponse {
  egressHandlers?: EgressHandler[];
}

interface EgressResponse {
  egressHandler?: EgressHandler;
}

interface DeleteEgressResponse {
  ok?: boolean;
  egressHandlerId?: string;
}

export async function runEgressTests(runner: E2ETestRunner, ctx: E2ETestContext): Promise<void> {
  await runner.runTest("List available egress handlers", async () => {
    const data = await ctx.authedJson<EgressListResponse>("/v1/egress-handlers/available");
    const names = data.egressHandlers?.map((handler) => handler.egressHandlerId).sort();
    if (!names?.includes("github") || !names.includes("cloudflare") || !names.includes("netlify")) {
      throw new Error(`Expected available github, cloudflare, and netlify handlers, got: ${JSON.stringify(names)}`);
    }
  });

  await runner.runTest("List configured egress handlers", async () => {
    const data = await ctx.authedJson<EgressListResponse>("/v1/egress-handlers?enabledOnly=false");
    const names = data.egressHandlers?.map((handler) => handler.egressHandlerId).sort();
    if (!names || names.length < 3) {
      throw new Error(`Expected at least 3 handlers, got: ${JSON.stringify(names)}`);
    }
    if (!names.includes("github") || !names.includes("cloudflare") || !names.includes("netlify")) {
      throw new Error(`Expected github, cloudflare, and netlify handlers, got: ${JSON.stringify(names)}`);
    }
  });

  await runner.runTest("Get Cloudflare egress handler", async () => {
    const data = await ctx.authedJson<EgressResponse>("/v1/egress-handlers/cloudflare");
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

  await runner.runTest("Configure, update, and delete Netlify egress handler", async () => {
    const configured = await ctx.authedJson<EgressResponse>("/v1/egress-handlers", {
      method: "POST",
      body: JSON.stringify({
        egressHandlerId: "netlify",
        secrets: { NETLIFY_AUTH_TOKEN: "e2e-test-token" },
        enabled: true,
      }),
    });
    if (configured.egressHandler?.egressHandlerId !== "netlify" || configured.egressHandler.enabled !== true) {
      throw new Error(`Netlify egress configure failed: ${JSON.stringify(configured)}`);
    }
    if (!configured.egressHandler.configuredSecrets?.includes("NETLIFY_AUTH_TOKEN")) {
      throw new Error(`Netlify egress should expose configured secret names only: ${JSON.stringify(configured)}`);
    }

    const updated = await ctx.authedJson<EgressResponse>("/v1/egress-handlers/netlify", {
      method: "PATCH",
      body: JSON.stringify({ enabled: false }),
    });
    if (updated.egressHandler?.enabled !== false) {
      throw new Error(`Netlify egress update failed: ${JSON.stringify(updated)}`);
    }

    const deleted = await ctx.authedJson<DeleteEgressResponse>("/v1/egress-handlers/netlify", {
      method: "DELETE",
    });
    if (!deleted.ok || deleted.egressHandlerId !== "netlify") {
      throw new Error(`Netlify egress delete failed: ${JSON.stringify(deleted)}`);
    }
  });

  await runner.runTest("generic egress is allowed", async () => {
    const sessionId = await ctx.createToolSession();
    const data = await ctx.invokeTool<{ ok?: boolean }>("execute_code", {
      code: "export default async function(input, env) { const response = await fetch('https://example.com'); return { status: response.status, body: await response.text() }; }",
    }, sessionId);
    const text = data.result.content[0]?.text ?? "";
    if (!data.result.details.ok || !text.includes('"status": 200') || !text.includes("Example Domain")) {
      throw new Error(`Expected generic egress to be allowed, got: ${JSON.stringify(data)}`);
    }
  });
}
