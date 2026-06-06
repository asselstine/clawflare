import type { Env, WorkerLoaderWorkerCode } from "../../../internal-types/index.js";
import type { ExecutionResult } from "../../../internal-types/tools.js";
import type { HttpGatewayProps } from "../../../egress/gateway.js";

interface DynamicExecutionOptions {
  requestId?: string;
  sessionId?: string;
  workspaceId?: string;
  executionId?: string;
  allowOutbound?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export const USER_FUNCTION_TYPES = `type Params = unknown;
type WorkerEnv = Record<string, never>;

export default function userFunction(
  input: Params,
  env: WorkerEnv,
): string | Promise<string>;`;

export const USER_FUNCTION_CONTRACT = `Provide JavaScript as an ES module with a default export matching this TypeScript contract:\n${USER_FUNCTION_TYPES}\n\nThe env argument has no direct secret bindings. Available globals include console, fetch, Request, Response, URL, and standard Worker runtime APIs; outbound fetch is routed through the configured egress gateway.\n\nExecutable JavaScript example:\nexport default async function(input, env) {
  return JSON.stringify({ message: "ok", input });
}`;

const WORKER_CACHE_PREFIX = "clawflare-execute-code";
const DEFAULT_DYNAMIC_WORKER_TIMEOUT_MS = 60_000;
const MAX_DYNAMIC_WORKER_TIMEOUT_MS = 5 * 60_000;

export async function executeDynamicWorker(
  env: Env,
  ctx: ExecutionContext | undefined,
  code: string,
  input?: unknown,
  options: DynamicExecutionOptions = {}
): Promise<ExecutionResult> {
  try {
    const outbound = options.allowOutbound === false ? null : createGatewayOutbound(env, ctx, options);
    const userModule = createUserModule(code);

    const workerCode: WorkerLoaderWorkerCode = {
      compatibilityDate: "2025-01-01",
      compatibilityFlags: ["nodejs_compat"],
      mainModule: "worker.js",
      limits: { cpuMs: 100, subRequests: 20 },
      env: {},
      modules: {
        "worker.js": {
          js: `import userFunction from "./user.js";

function formatConsoleArg(value) {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.stack || value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function formatConsoleArgs(args) {
  return args.map(formatConsoleArg).join(" ");
}

export default {
  async fetch(request, env) {
    const stdout = [];
    const stderr = [];
    const originalConsole = globalThis.console;
    globalThis.console = {
      ...originalConsole,
      log: (...args) => {
        stdout.push(formatConsoleArgs(args));
        return originalConsole.log(...args);
      },
      info: (...args) => {
        stdout.push(formatConsoleArgs(args));
        return originalConsole.info(...args);
      },
      warn: (...args) => {
        stderr.push(formatConsoleArgs(args));
        return originalConsole.warn(...args);
      },
      error: (...args) => {
        stderr.push(formatConsoleArgs(args));
        return originalConsole.error(...args);
      },
    };

    try {
      if (typeof userFunction !== "function") {
        throw new Error("Dynamic Worker user module default export must be a function.");
      }
      const input = await request.json();
      const result = await userFunction(input, env);
      return Response.json({ ok: true, result, stdout: stdout.join("\\n"), stderr: stderr.join("\\n") });
    } catch (error) {
      return Response.json({ ok: false, error: error && error.message ? error.message : String(error), stdout: stdout.join("\\n"), stderr: stderr.join("\\n") }, { status: 500 });
    } finally {
      globalThis.console = originalConsole;
    }
  }
};`,
        },
        "user.js": { js: userModule },
      },
    };

    workerCode.globalOutbound = outbound ?? null;

    const workerName = await getWorkerCacheName(workerCode, options);
    const worker = await env.LOADER.get(workerName, () => workerCode);
    const entrypoint = worker.getEntrypoint();
    const response = await withTimeout(
      entrypoint.fetch(
        new Request("https://clawflare.local/execute", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input ?? null),
        })
      ),
      options.timeoutMs,
      options.signal,
    );

    const payload = await readJson(response);
    if (!response.ok || !payload.ok) {
      return {
        ok: false,
        error: String(payload.error || `Dynamic Worker failed with status ${response.status}`),
        stdout: payload.stdout,
        stderr: payload.stderr,
      };
    }

    return { ok: true, result: payload.result, stdout: payload.stdout, stderr: payload.stderr };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function effectiveTimeoutMs(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined) return DEFAULT_DYNAMIC_WORKER_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs)) return DEFAULT_DYNAMIC_WORKER_TIMEOUT_MS;
  return Math.min(Math.max(Math.floor(timeoutMs), 1), MAX_DYNAMIC_WORKER_TIMEOUT_MS);
}

function abortError(): Error {
  const error = new Error("Dynamic Worker execution aborted.");
  error.name = "AbortError";
  return error;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number | undefined,
  signal?: AbortSignal,
): Promise<T> {
  const timeout = effectiveTimeoutMs(timeoutMs);

  if (signal?.aborted) {
    throw abortError();
  }

  return await new Promise<T>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      cleanup();
      reject(new Error(`Dynamic Worker execution timed out after ${timeout}ms.`));
    }, timeout);

    const onAbort = () => {
      cleanup();
      reject(abortError());
    };

    const cleanup = () => {
      clearTimeout(timeoutId);
      signal?.removeEventListener("abort", onAbort);
    };

    signal?.addEventListener("abort", onAbort, { once: true });

    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function createGatewayOutbound(
  env: Env,
  ctx: ExecutionContext | undefined,
  options: DynamicExecutionOptions
): Fetcher {
  if (!options.sessionId && !options.workspaceId && !options.requestId) {
    return env.HTTP_GATEWAY;
  }

  const ctxExports = (ctx as unknown as { exports?: Record<string, unknown> } | undefined)?.exports;
  const httpGateway = ctxExports?.HttpGateway as
    | ((options: { props?: HttpGatewayProps }) => Fetcher)
    | undefined;

  if (!httpGateway) {
    return env.HTTP_GATEWAY;
  }

  return httpGateway({
    props: {
      requestId: options.requestId,
      workspaceId: options.workspaceId,
      sessionId: options.sessionId,
    },
  });
}

function createUserModule(code: string): string {
  if (!hasDefaultExport(code)) {
    throw new Error(`Dynamic Worker code must be an ES module with a default exported function.\n\n${USER_FUNCTION_CONTRACT}`);
  }
  return code;
}

async function getWorkerCacheName(
  workerCode: WorkerLoaderWorkerCode,
  options: DynamicExecutionOptions
): Promise<string> {
  const cacheScope = {
    allowOutbound: options.allowOutbound !== false,
    executionId: options.executionId ?? null,
    requestId: options.requestId ?? null,
    sessionId: options.sessionId ?? null,
    workspaceId: options.workspaceId ?? null,
  };
  const cachePayload = {
    ...workerCode,
    globalOutbound: Boolean(workerCode.globalOutbound),
    cacheScope,
  };
  const hash = await sha256Hex(JSON.stringify(cachePayload));
  return `${WORKER_CACHE_PREFIX}-${hash}`;
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function hasDefaultExport(code: string): boolean {
  return /(^|\n)\s*export\s+default\s+/.test(code);
}

async function readJson(response: Response): Promise<{ ok?: boolean; result?: unknown; error?: unknown; stdout?: string; stderr?: string }> {
  const text = await response.text();
  if (!text) {
    return { ok: false, error: "Dynamic Worker returned an empty response." };
  }

  try {
    return JSON.parse(text) as { ok?: boolean; result?: unknown; error?: unknown; stdout?: string; stderr?: string };
  } catch {
    return { ok: false, error: text };
  }
}
