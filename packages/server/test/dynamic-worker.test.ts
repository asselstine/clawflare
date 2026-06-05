import { describe, expect, it, vi } from "vitest";
import type { Env, WorkerLoaderWorkerCode } from "../src/internal-types/index.js";
import { executeDynamicWorker } from "../src/modules/tools/code/dynamic-worker.js";

function createWorker() {
  return {
    getEntrypoint: () => ({
      fetch: vi.fn(async () => Response.json({
        ok: true,
        result: "ok",
        stdout: "",
        stderr: "",
      })),
    }),
  };
}

describe("dynamic worker execution", () => {
  it("uses stable loader names for identical code and execution scope", async () => {
    const names: string[] = [];
    const get = vi.fn(async (
      name: string | null,
      getCode: () => WorkerLoaderWorkerCode | Promise<WorkerLoaderWorkerCode>
    ) => {
      names.push(name ?? "");
      await getCode();
      return createWorker();
    });
    const load = vi.fn();
    const env = {
      LOADER: { get, load },
      HTTP_GATEWAY: {},
    } as unknown as Env;
    const code = "export default async function() { return 'ok'; }";
    const options = {
      requestId: "session:abc",
      sessionId: "abc",
      workspaceId: "workspace-1",
    };

    await executeDynamicWorker(env, undefined, code, null, options);
    await executeDynamicWorker(env, undefined, code, null, options);

    expect(load).not.toHaveBeenCalled();
    expect(get).toHaveBeenCalledTimes(2);
    expect(names[0]).toBe(names[1]);
    expect(names[0]).toMatch(/^clawflare-execute-code-[a-f0-9]{64}$/);
  });

  it("scopes loader names by execution context", async () => {
    const names: string[] = [];
    const env = {
      LOADER: {
        get: vi.fn(async (
          name: string | null,
          getCode: () => WorkerLoaderWorkerCode | Promise<WorkerLoaderWorkerCode>
        ) => {
          names.push(name ?? "");
          await getCode();
          return createWorker();
        }),
        load: vi.fn(),
      },
      HTTP_GATEWAY: {},
    } as unknown as Env;
    const code = "export default async function() { return 'ok'; }";

    await executeDynamicWorker(env, undefined, code, null, {
      requestId: "session:abc",
      sessionId: "abc",
      workspaceId: "workspace-1",
    });
    await executeDynamicWorker(env, undefined, code, null, {
      requestId: "session:def",
      sessionId: "def",
      workspaceId: "workspace-1",
    });

    expect(names[0]).not.toBe(names[1]);
  });
});
