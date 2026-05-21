import { describe, expect, it } from "vitest";
import { formatExecutionResult, MAX_TOOL_RESPONSE_LENGTH_CHARS } from "../src/tools/index.js";
import { createGithubArchiveBootstrapCommand, parseGithubCloneUrl } from "../src/container/tools.js";

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
    expect(text).toContain("Tool output truncated");
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
    expect(text).toContain("Tool output truncated");
  });
});

describe("GitHub container archive bootstrap", () => {
  it.each([
    ["https://github.com/owner/repo.git", { owner: "owner", repo: "repo" }],
    ["https://github.com/owner/repo", { owner: "owner", repo: "repo" }],
    ["ssh://git@github.com/owner/repo.git", { owner: "owner", repo: "repo" }],
    ["git@github.com:owner/repo.git", { owner: "owner", repo: "repo" }],
    ["https://github.com/owner/repo.git#dev", { owner: "owner", repo: "repo", ref: "dev" }],
  ])("parses %s", (input, expected) => {
    expect(parseGithubCloneUrl(input)).toEqual(expected);
  });

  it.each([
    "https://gitlab.com/owner/repo.git",
    "https://github.com/owner/repo/extra",
    "git@github.com:owner/repo/path.git",
  ])("rejects unsupported clone URL %s", (input) => {
    expect(parseGithubCloneUrl(input)).toBeNull();
  });

  it("creates a codeload bootstrap command using repository metadata from inside the container", async () => {
    const command = await createGithubArchiveBootstrapCommand(
      {} as never,
      "https://github.com/owner/repo.git"
    );

    expect(command).toContain("https://api.github.com/repos/owner/repo");
    expect(command).toContain("https://codeload.github.com/");
    expect(command).toContain("tar -xzf");
  });
});
