import { describe, expect, it } from "vitest";
import { formatExecutionResult, MAX_TOOL_RESPONSE_LENGTH_CHARS } from "../src/modules/tools/code/output.js";
import { tailToolOutput } from "../src/modules/tools/container/output.js";

describe("tool output formatting", () => {
  it("shows captured stdout when code returns no explicit result", () => {
    const result = formatExecutionResult({
      ok: true,
      stdout: "loaded docs\nparsed section",
    });

    const text = result.content[0]?.type === "text" ? result.content[0].text : "";

    expect(text).toBe("Stdout:\nloaded docs\nparsed section");
  });

  it("marks failed execution details as not ok", () => {
    const result = formatExecutionResult({ ok: false, error: "require is not defined" });

    expect(result.details).toMatchObject({ ok: false });
  });

  it("tails oversized successful tool output at the hard cap", () => {
    const result = formatExecutionResult({
      ok: true,
      result: "a".repeat(MAX_TOOL_RESPONSE_LENGTH_CHARS + 100) + "TAIL",
    });

    const text = result.content[0]?.type === "text" ? result.content[0].text : "";

    expect(text.length).toBeLessThanOrEqual(MAX_TOOL_RESPONSE_LENGTH_CHARS);
    expect(text).not.toContain("Tool output truncated");
    expect(text.endsWith("TAIL\"")).toBe(true);
    expect(result.details).toMatchObject({ truncated: true });
  });

  it("honors maxResponseLength below the hard cap", () => {
    const result = formatExecutionResult(
      { ok: true, result: "0123456789".repeat(100) },
      { maxResponseLength: 200 },
    );

    const text = result.content[0]?.type === "text" ? result.content[0].text : "";

    expect(text.length).toBeLessThanOrEqual(200);
    expect(text).not.toContain("Tool output truncated");
    expect(result.details).toMatchObject({ truncated: true, originalLength: 1010, limit: 200 });
  });

  it("tails oversized container output without injecting a synthetic banner into content", () => {
    const output = tailToolOutput("0123456789".repeat(100), 25);

    expect(output.text).toBe("5678901234567890123456789");
    expect(output.text).not.toContain("Tool output truncated");
    expect(output).toMatchObject({ truncated: true, originalLength: 1000, limit: 25 });
  });
});
