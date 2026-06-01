import { describe, expect, it } from "vitest";
import { buildContainerRuntimeFailureMessage } from "../src/modules/tools/container/client.js";

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
