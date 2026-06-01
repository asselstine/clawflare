/**
 * Cloudflare egress handler production-surface check.
 *
 * Handler routing/auth behavior is covered by package and server unit tests.
 * This file only verifies that a deployed harness exposes safe egress handler
 * metadata through the production API.
 */

import { describe, it, expect, beforeAll } from "vitest";

const TEST_URL =
  process.env.TEST_URL ||
  process.env.HARNESS_URL ||
  (process.argv.find((arg, i) => process.argv[i - 1] === "--url") ?? null);
const TEST_TOKEN =
  process.env.CLAWFLARE_API_TOKEN ||
  process.env.TEST_TOKEN ||
  "";

const shouldSkip = !TEST_URL || !TEST_TOKEN;

describe("Cloudflare Egress Integration Tests", () => {
  beforeAll(async () => {
    if (shouldSkip) {
      console.log(
        "Skipping tests - set TEST_URL/HARNESS_URL and CLAWFLARE_API_TOKEN/TEST_TOKEN."
      );
      return;
    }

    let ready = false;
    for (let i = 0; i < 30; i++) {
      try {
        const response = await fetch(`${TEST_URL}/health`, { method: "GET" });
        if (response.ok) {
          ready = true;
          break;
        }
      } catch {
        // Remote route may not be propagated yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    if (!ready) throw new Error("Remote Worker failed to become responsive");
  }, 35000);

  it("exposes Cloudflare egress handler metadata", async () => {
    if (shouldSkip) return;

    const response = await fetch(`${TEST_URL}/v1/egress-handlers/cloudflare`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    const data = (await response.json()) as {
      egressHandler?: {
        name: string;
        domains?: string[];
        config?: unknown;
      };
    };

    expect(response.status).toBe(200);
    expect(data.egressHandler?.name).toBe("cloudflare");
    expect(data.egressHandler?.domains).toContain("api.cloudflare.com");
    expect(data.egressHandler).not.toHaveProperty("config");
  }, 10000);
});
