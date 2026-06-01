import { describe, expect, it } from "vitest";
import { createContainerToolsIfAvailable, createTools } from "../src/modules/tools/tools.service.js";
import type { Env } from "../src/internal-types/index.js";

describe("tools", () => {
  describe("createTools", () => {
    it("creates core tools", () => {
      const mockEnv = {} as Env;
      const tools = createTools(mockEnv);
      const toolNames = tools.map(t => t.name);

      // Should have core tools
      expect(toolNames).toContain("store_code");
      expect(toolNames).toContain("execute_stored_code");
      expect(toolNames).toContain("execute_code");
      expect(toolNames).toContain("search");
      
      // Core (4) without container tools = 4
      expect(tools.length).toBe(4);
    });

    it("includes container tools when sessionId is provided", () => {
      const mockEnv = {} as Env;
      const toolCtx = { sessionId: "test-session" };
      const tools = createTools(mockEnv, undefined, toolCtx);
      const toolNames = tools.map(t => t.name);

      // Should have container tools
      expect(toolNames).toContain("container_create");
      expect(toolNames).toContain("container_bash");
      expect(toolNames).toContain("container_read");
      expect(toolNames).toContain("container_destroy");
      
      // Core (4) + Container (9) = 13
      expect(tools.length).toBe(13);
    });

    it("excludes container tools when no sessionId is provided", () => {
      const mockEnv = {} as Env;
      const tools = createTools(mockEnv);
      const toolNames = tools.map(t => t.name);

      // Should NOT have container tools
      expect(toolNames).not.toContain("container_create");
      expect(toolNames).not.toContain("container_bash");
      
      // Just core tools
      expect(tools.length).toBe(4);
    });
  });

  describe("createContainerToolsIfAvailable", () => {
    it("returns empty array when no sessionId provided", () => {
      const mockEnv = {} as Env;
      const tools = createContainerToolsIfAvailable(mockEnv);
      expect(tools).toEqual([]);
    });

    it("returns container tools when sessionId provided", () => {
      const mockEnv = {} as Env;
      const toolCtx = { sessionId: "test-session" };
      const tools = createContainerToolsIfAvailable(mockEnv, toolCtx);
      expect(tools.length).toBe(9);
    });
  });
});

// Note: Plugin tools and user-defined tools were removed as part of Phase 4 de-packaging.
// The public config API (defineClawflareConfig, ClawflarePlugin, ClawflareConfig, etc.)
// has been deleted. Tools are now just:
// 1. Core tools (store_code, execute_stored_code, execute_code, search)
// 2. Container tools (when sessionId is provided)
