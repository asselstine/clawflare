import type { Env, WorkerLoaderWorkerCode } from "./../internal-types/index.js";
import type { ExecutionResult } from "./../internal-types/tools.js";

interface DynamicExecutionOptions {
  requestId?: string;
  allowOutbound?: boolean;
}

export async function executeDynamicWorker(
  env: Env,
  _ctx: ExecutionContext | undefined,
  code: string,
  input?: unknown,
  options: DynamicExecutionOptions = {}
): Promise<ExecutionResult> {
  try {
    const outbound = options.allowOutbound === false ? null : createGatewayOutbound(env);

    const workerCode: WorkerLoaderWorkerCode = {
      compatibilityDate: "2025-01-01",
      compatibilityFlags: ["nodejs_compat"],
      mainModule: "worker.js",
      limits: { cpuMs: 100, subRequests: 20 },
      env: {},
      modules: {
        "worker.js": {
          js: `import userFunction from "./user.js";

export default {
  async fetch(request, env) {
    try {
      const input = await request.json();
      const result = await userFunction(input, env);
      return Response.json({ ok: true, result });
    } catch (error) {
      return Response.json({ ok: false, error: error && error.message ? error.message : String(error) }, { status: 500 });
    }
  }
};`,
        },
        "user.js": { js: wrapUserCode(code) },
      },
    };

    workerCode.globalOutbound = outbound ?? null;

    const worker = await env.LOADER.load(workerCode);
    const entrypoint = worker.getEntrypoint();
    const response = await entrypoint.fetch(
      new Request("https://clawflare.local/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input ?? null),
      })
    );

    const payload = await readJson(response);
    if (!response.ok || !payload.ok) {
      return { ok: false, error: String(payload.error || `Dynamic Worker failed with status ${response.status}`) };
    }

    return { ok: true, result: payload.result };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function createGatewayOutbound(env: Env): Fetcher {
  return env.HTTP_GATEWAY;
}

function wrapUserCode(code: string): string {
  const indented = code
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");

  return `export default async function(input, env) {
${indented}
}`;
}

async function readJson(response: Response): Promise<{ ok?: boolean; result?: unknown; error?: unknown }> {
  try {
    return (await response.json()) as { ok?: boolean; result?: unknown; error?: unknown };
  } catch {
    return { ok: false, error: await response.text() };
  }
}
