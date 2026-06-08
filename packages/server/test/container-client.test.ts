import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildContainerRuntimeFailureMessage,
  buildContainerStartupFailureMessage,
  containerBashStart,
  getContainerHealth,
  isContainerCodeUpdateResetError,
} from "../src/modules/tools/container/client.js";
import type { Env } from "../src/internal-types/index.js";

const containerMocks = vi.hoisted(() => ({
  containerFetch: vi.fn(),
  setOutboundHandler: vi.fn(),
  startAndWaitForPorts: vi.fn(),
}));

vi.mock("@cloudflare/containers", () => ({
  getContainer: vi.fn(() => ({
    containerFetch: containerMocks.containerFetch,
    setOutboundHandler: containerMocks.setOutboundHandler,
    startAndWaitForPorts: containerMocks.startAndWaitForPorts,
  })),
}));

beforeEach(() => {
  containerMocks.containerFetch.mockReset();
  containerMocks.setOutboundHandler.mockReset();
  containerMocks.startAndWaitForPorts.mockReset();
});

describe("container runtime failure formatting", () => {
  it("includes command stdout and stderr for runtime ok=false responses", () => {
    const message = buildContainerRuntimeFailureMessage(
      { ok: true, status: 200, statusText: "OK" },
      {
        ok: false,
        exitCode: 128,
        signal: null,
        stdout: "cloning repo\n",
        stderr: "fatal: unable to access repository\n",
        durationMs: 1234,
      },
      "",
    );

    expect(message).toContain("runtime reported ok=false (HTTP 200 OK)");
    expect(message).toContain("Exit code: 128");
    expect(message).toContain("Duration: 1234ms");
    expect(message).toContain("Stdout:\ncloning repo");
    expect(message).toContain("Stderr:\nfatal: unable to access repository");
  });

  it("includes raw response body when the runtime does not return JSON", () => {
    const message = buildContainerRuntimeFailureMessage(
      { ok: false, status: 502, statusText: "Bad Gateway" },
      null,
      "upstream unavailable",
    );

    expect(message).toContain("HTTP 502 Bad Gateway");
    expect(message).toContain("Response body:\nupstream unavailable");
  });
});

describe("container startup failure formatting", () => {
  it("recognizes Cloudflare code update reset errors", () => {
    const error = new Error("Durable Object reset because its code was updated.");

    expect(isContainerCodeUpdateResetError(error)).toBe(true);
    expect(isContainerCodeUpdateResetError("some other startup failure")).toBe(false);
  });

  it("formats code update reset errors as retryable container startup failures", () => {
    const message = buildContainerStartupFailureMessage(
      "session-abc",
      new Error("Durable Object reset because its code was updated."),
    );

    expect(message).toContain("Container session-abc was interrupted by a Worker deployment");
    expect(message).toContain("Retry the operation");
    expect(message).toContain("older session");
  });

  it("preserves ordinary startup error details", () => {
    const message = buildContainerStartupFailureMessage("session-abc", new Error("port timeout"));

    expect(message).toBe("Container session-abc failed to start: port timeout");
  });
});

describe("container egress setup", () => {
  it("passes the logical container ID to the outbound handler", async () => {
    containerMocks.startAndWaitForPorts.mockResolvedValue(undefined);
    containerMocks.setOutboundHandler.mockResolvedValue(undefined);
    containerMocks.containerFetch.mockImplementation(() => Promise.resolve(
      new Response(JSON.stringify({
        ok: true,
        status: "healthy",
        workspace: "/workspace",
      }))
    ));

    await getContainerHealth({ CODING_CONTAINER: {} } as Env, "session-abc");

    expect(containerMocks.startAndWaitForPorts).toHaveBeenCalledWith(expect.objectContaining({
      cancellationOptions: { portReadyTimeoutMS: 30_000 },
    }));
    expect(containerMocks.startAndWaitForPorts).not.toHaveBeenCalledWith(expect.objectContaining({
      cancellationOptions: expect.objectContaining({ abort: expect.anything() }),
    }));
    expect(containerMocks.setOutboundHandler).toHaveBeenCalledWith(
      "clawflare",
      { containerId: "session-abc" }
    );
  });

  it("does not pass AbortSignal objects through container RPC calls", async () => {
    const controller = new AbortController();
    containerMocks.startAndWaitForPorts.mockResolvedValue(undefined);
    containerMocks.setOutboundHandler.mockResolvedValue(undefined);
    containerMocks.containerFetch.mockImplementation(() => Promise.resolve(
      new Response(JSON.stringify({
        ok: true,
        status: "healthy",
        workspace: "/workspace",
      }))
    ));

    await getContainerHealth({ CODING_CONTAINER: {} } as Env, "session-signal", controller.signal);

    expect(containerMocks.startAndWaitForPorts).toHaveBeenCalledWith(expect.objectContaining({
      cancellationOptions: { portReadyTimeoutMS: 30_000 },
    }));
    expect(containerMocks.containerFetch).toHaveBeenCalledWith(
      "http://localhost/health",
      { method: "GET" }
    );
  });

  it("reuses readiness setup for warm containers", async () => {
    containerMocks.startAndWaitForPorts.mockResolvedValue(undefined);
    containerMocks.setOutboundHandler.mockResolvedValue(undefined);
    containerMocks.containerFetch.mockImplementation(() => Promise.resolve(
      new Response(JSON.stringify({
        ok: true,
        status: "healthy",
        workspace: "/workspace",
      }))
    ));

    await getContainerHealth({ CODING_CONTAINER: {} } as Env, "session-cache");
    await getContainerHealth({ CODING_CONTAINER: {} } as Env, "session-cache");

    expect(containerMocks.startAndWaitForPorts).toHaveBeenCalledTimes(1);
    expect(containerMocks.setOutboundHandler).toHaveBeenCalledTimes(1);
    expect(containerMocks.containerFetch).toHaveBeenCalledTimes(2);
  });

  it("uses the 30 minute bash timeout by default without changing startup timeout", async () => {
    containerMocks.startAndWaitForPorts.mockResolvedValue(undefined);
    containerMocks.setOutboundHandler.mockResolvedValue(undefined);
    containerMocks.containerFetch.mockImplementation(() => Promise.resolve(
      new Response(JSON.stringify({
        ok: true,
        commandId: "cmd-1",
        state: "running",
        startedAt: 1,
        timeoutMs: 1_800_000,
      }))
    ));

    await containerBashStart({ CODING_CONTAINER: {} } as Env, "session-bash", "git clone https://example.com/repo.git");

    expect(containerMocks.startAndWaitForPorts).toHaveBeenCalledWith(expect.objectContaining({
      cancellationOptions: { portReadyTimeoutMS: 30_000 },
    }));
    expect(containerMocks.containerFetch).toHaveBeenCalledWith(
      "http://localhost/bash/start",
      expect.objectContaining({
        body: expect.stringContaining("\"timeoutMs\":1800000"),
      })
    );
  });
});
