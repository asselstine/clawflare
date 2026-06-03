import { describe, expect, it } from "vitest";
import { listBuiltinTools, loadSessionTools } from "../src/modules/tools/tools.service.js";
import type { Env } from "../src/internal-types/index.js";

describe("tools", () => {
  describe("loadSessionTools", () => {
    it("lists builtin tools for discovery", () => {
      const tools = listBuiltinTools();
      const toolNames = tools.map(t => t.name);

      expect(toolNames).toContain("store_code");
      expect(toolNames).toContain("execute_stored_code");
      expect(toolNames).toContain("execute_code");
      expect(toolNames).toContain("search");
      expect(toolNames).toContain("container_create");
    });

    it("requires a session", async () => {
      const mockEnv = {} as Env;
      await expect(loadSessionTools(mockEnv)).rejects.toThrow("Tool loading requires a session");
    });

    it("resolves persisted session tool refs", async () => {
      const mockEnv = {
        DB: {
          query: {
            sessionTools: {
              findMany: () => Promise.resolve([
                {
                  sessionId: "test-session",
                  toolRefType: "builtin",
                  toolRef: "code.execute_code",
                  enabled: 1,
                  configJson: "{}",
                  pinnedVersionId: null,
                  createdAt: Date.now(),
                  updatedAt: Date.now(),
                },
              ]),
            },
          },
        },
      } as unknown as Env;
      const tools = await loadSessionTools(mockEnv, "test-session");
      const toolNames = tools.map(t => t.name);

      expect(toolNames).toEqual(["execute_code"]);
    });
  });

});

// Note: Plugin tools and user-defined tools were removed as part of Phase 4 de-packaging.
// The public config API (defineClawflareConfig, ClawflarePlugin, ClawflareConfig, etc.)
// has been deleted. Tools are now just:
// 1. Core tools (store_code, execute_stored_code, execute_code, search)
// 2. Container tools (when sessionId is provided)
