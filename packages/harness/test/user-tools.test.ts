import { describe, expect, it } from "vitest";
import { defineTool, createCoreTools, createPluginTools, createUserTools, createTools } from "../src/tools/index.js";
import type { ClawflareConfig } from "../src/config-api.js";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Env } from "../src/internal-types/index.js";

describe("user-defined tools", () => {
  describe("defineTool", () => {
    it("creates a tool factory with the correct structure", () => {
      const tool = defineTool({
        name: "hello",
        description: "Says hello",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string" }
          }
        },
        execute: async (_params: unknown, _context): Promise<AgentToolResult<unknown>> => ({
          content: [{ type: "text", text: "Hello!" }],
          details: {},
        }),
      });

      expect(tool.name).toBe("hello");
      expect(tool.description).toBe("Says hello");
      expect(tool.parameters).toEqual({
        type: "object",
        properties: {
          name: { type: "string" }
        }
      });
      expect(tool.def).toBeDefined();
    });
  });

  describe("createCoreTools", () => {
    it("creates the base set of core tools", () => {
      // Mock env - we only need to check the tool names
      const mockEnv = {} as Env;
      const tools = createCoreTools(mockEnv);
      const toolNames = tools.map(t => t.name);

      expect(toolNames).toContain("store_code");
      expect(toolNames).toContain("execute_stored_code");
      expect(toolNames).toContain("execute_code");
      expect(toolNames).toContain("search");
      expect(tools.length).toBe(4);
    });
  });

  describe("createPluginTools", () => {
    it("returns empty array when no config provided", () => {
      const mockEnv = {} as Env;
      const tools = createPluginTools(undefined, mockEnv);
      expect(tools).toEqual([]);
    });

    it("returns empty array when config has no plugins", () => {
      const mockEnv = {} as Env;
      const config: ClawflareConfig = { name: "test" };
      const tools = createPluginTools(config, mockEnv);
      expect(tools).toEqual([]);
    });

    it("creates tools from plugins", () => {
      const mockEnv = {} as Env;
      const agentTool: AgentTool = {
        name: "plugin_tool",
        description: "A test tool",
        label: "Plugin Tool",
        parameters: { type: "object" } as any,
        execute: async (_id: string, _params: unknown, _signal?: AbortSignal): Promise<AgentToolResult<unknown>> => ({
          content: [{ type: "text", text: "success" }],
          details: { success: true },
        }),
      };

      const config: ClawflareConfig = {
        name: "test",
        plugins: [
          {
            name: "test-plugin",
            registerTools: () => [agentTool],
          },
        ],
      };

      const tools = createPluginTools(config, mockEnv);
      expect(tools.length).toBe(1);
      expect(tools[0]!.name).toBe("plugin_tool");
    });
  });

  describe("createUserTools", () => {
    it("returns empty array when no config provided", () => {
      const mockEnv = {} as Env;
      const tools = createUserTools(undefined, mockEnv);
      expect(tools).toEqual([]);
    });

    it("returns empty array when config has no tools", () => {
      const mockEnv = {} as Env;
      const config: ClawflareConfig = { name: "test" };
      const tools = createUserTools(config, mockEnv);
      expect(tools).toEqual([]);
    });

    it("creates tools from config tool factories", () => {
      const mockEnv = {} as Env;
      const customTool: AgentTool = {
        name: "custom_tool",
        description: "A custom tool",
        label: "Custom Tool",
        parameters: { type: "object" } as any,
        execute: async (): Promise<AgentToolResult<unknown>> => ({
          content: [{ type: "text", text: "success" }],
          details: { success: true },
        }),
      };

      const config: ClawflareConfig = {
        name: "test",
        tools: [
          () => customTool,
        ],
      };

      const tools = createUserTools(config, mockEnv, undefined);
      expect(tools.length).toBe(1);
      expect(tools[0]!.name).toBe("custom_tool");
    });

    it("creates multiple tools from a single factory returning an array", () => {
      const mockEnv = {} as Env;
      const tool1: AgentTool = {
        name: "tool_1",
        description: "First tool",
        label: "Tool 1",
        parameters: { type: "object" } as any,
        execute: async (): Promise<AgentToolResult<unknown>> => ({
          content: [{ type: "text", text: "1" }],
          details: { result: 1 },
        }),
      };
      const tool2: AgentTool = {
        name: "tool_2",
        description: "Second tool",
        label: "Tool 2",
        parameters: { type: "object" } as any,
        execute: async (): Promise<AgentToolResult<unknown>> => ({
          content: [{ type: "text", text: "2" }],
          details: { result: 2 },
        }),
      };

      const config: ClawflareConfig = {
        name: "test",
        tools: [
          () => [tool1, tool2],
        ],
      };

      const tools = createUserTools(config, mockEnv);
      expect(tools.length).toBe(2);
      expect(tools.map((t: AgentTool) => t.name)).toEqual(["tool_1", "tool_2"]);
    });
  });

  describe("createTools", () => {
    it("combines core and user tools", () => {
      const mockEnv = {} as Env;
      const userTool: AgentTool = {
        name: "custom_tool",
        description: "A custom tool",
        label: "Custom Tool",
        parameters: { type: "object" } as any,
        execute: async (): Promise<AgentToolResult<unknown>> => ({
          content: [{ type: "text", text: "success" }],
          details: { success: true },
        }),
      };

      const config: ClawflareConfig = {
        name: "test",
        tools: [
          () => userTool,
        ],
      };

      const toolCtx = { sessionId: "test-session", config };
      const tools = createTools(mockEnv, undefined, toolCtx);
      const toolNames = tools.map(t => t.name);

      // Should have core tools
      expect(toolNames).toContain("store_code");
      expect(toolNames).toContain("execute_stored_code");
      expect(toolNames).toContain("execute_code");
      expect(toolNames).toContain("search");
      
      // Should have user tool
      const foundUserTool = tools.find(t => t.name === "custom_tool");
      expect(foundUserTool).toBeDefined();
      
      // Core (4) + Container (8, because sessionId) + User (1) = 13
      expect(tools.length).toBe(13);
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
      
      // Core (4) + Container (8) = 12
      expect(tools.length).toBe(12);
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
});
