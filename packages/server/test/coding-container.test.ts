import { describe, expect, it, vi } from "vitest";
import { CodingContainer } from "../src/modules/tools/container/coding-container.js";

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class WorkerEntrypoint {},
}));

describe("CodingContainer", () => {
  it("configures git smart HTTP to use HTTP/1.1 inside intercepted HTTPS containers", () => {
    const container = new CodingContainer({} as never, {} as never);

    expect(container.envVars.GIT_SSL_CAINFO).toBe("/etc/cloudflare/certs/cloudflare-containers-ca.crt");
    expect(container.envVars.GIT_CONFIG_COUNT).toBe("1");
    expect(container.envVars.GIT_CONFIG_KEY_0).toBe("http.version");
    expect(container.envVars.GIT_CONFIG_VALUE_0).toBe("HTTP/1.1");
  });
});
