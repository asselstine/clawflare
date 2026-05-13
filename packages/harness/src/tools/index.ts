// Tools for the Clawflare Agent
// These are the tools that the agent can use to interact with Cloudflare

import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { Static, TSchema } from "@earendil-works/pi-ai";

export function createTools(): AgentTool[] {
  return [
    createDeployTool(),
    createExecuteCodeTool(),
    createListWorkersTool(),
    createGetWorkerTool(),
    createCreateKVTool(),
    createCreateD1Tool(),
    createListResourcesTool(),
  ];
}

interface DeployParams {
  name: string;
  code: string;
  description: string;
}

interface ExecuteCodeParams {
  code: string;
}

interface GetWorkerParams {
  name: string;
}

interface CreateKVParams {
  title: string;
}

interface CreateD1Params {
  name: string;
}

// Tool: Deploy a new Tool (creates a new Dynamic Worker)
function createDeployTool(): AgentTool {
  return {
    name: "deploy_tool",
    description: "Deploy a new Cloudflare Worker tool. Use this when you need to create a new tool that can be called later.",
    label: "Deploy Tool",
    parameters: Type.Object({
      name: Type.String({ description: "Name of the tool/worker" }),
      code: Type.String({ description: "JavaScript code for the tool" }),
      description: Type.String({ description: "Description of what the tool does" }),
    }) as TSchema,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    execute: async (_toolCallId: string, params: Static<TSchema>, _signal?: AbortSignal): Promise<AgentToolResult<any>> => {
      const p = params as DeployParams;
      
      // Use the Cloudflare API to create a new Worker
      const accountId = getAccountId();
      
      const response = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${p.name}`,
        {
          method: "PUT",
          headers: {
            "Authorization": `Bearer ${CLOUDFLARE_API_TOKEN}`,
            "Content-Type": "application/javascript",
          },
          body: p.code,
        }
      );

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Failed to deploy: ${error}`);
      }

      return {
        content: [{ type: "text", text: `Successfully deployed tool: ${p.name}` }],
        details: { name: p.name, status: "deployed" },
      };
    },
  };
}

// Tool: Execute code in a dynamic worker
function createExecuteCodeTool(): AgentTool {
  return {
    name: "execute_code",
    description: "Execute JavaScript code in an isolated Cloudflare Worker. Use this to run code that doesn't need to be deployed as a persistent tool.",
    label: "Execute Code",
    parameters: Type.Object({
      code: Type.String({ description: "JavaScript code to execute" }),
    }) as TSchema,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    execute: async (_toolCallId: string, params: Static<TSchema>, _signal?: AbortSignal): Promise<AgentToolResult<any>> => {
      const p = params as ExecuteCodeParams;
      
      // For now, we'll return the code as a simulation
      // In production, you'd use Cloudflare Codemode or a sandboxed execution environment
      return {
        content: [{ type: "text", text: `Code prepared for execution:\n${p.code}` }],
        details: { code: p.code, mode: "simulation" },
      };
    },
  };
}

// Tool: List existing Workers
function createListWorkersTool(): AgentTool {
  return {
    name: "list_workers",
    description: "List all Cloudflare Workers in your account.",
    label: "List Workers",
    parameters: Type.Object({}) as TSchema,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    execute: async (_toolCallId: string, _params: Static<TSchema>, _signal?: AbortSignal): Promise<AgentToolResult<any>> => {
      const accountId = getAccountId();
      const response = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers`,
        {
          headers: { "Authorization": `Bearer ${CLOUDFLARE_API_TOKEN}` },
        }
      );

      if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
      }

      const data = await response.json() as { result: unknown[] };
      
      return {
        content: [{ type: "text", text: `Workers: ${JSON.stringify(data.result, null, 2)}` }],
        details: { workers: data.result },
      };
    },
  };
}

// Tool: Get Worker details
function createGetWorkerTool(): AgentTool {
  return {
    name: "get_worker",
    description: "Get details about a specific Cloudflare Worker.",
    label: "Get Worker",
    parameters: Type.Object({
      name: Type.String({ description: "Name of the worker" }),
    }) as TSchema,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    execute: async (_toolCallId: string, params: Static<TSchema>, _signal?: AbortSignal): Promise<AgentToolResult<any>> => {
      const p = params as GetWorkerParams;
      const accountId = getAccountId();
      const response = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${p.name}`,
        {
          headers: { "Authorization": `Bearer ${CLOUDFLARE_API_TOKEN}` },
        }
      );

      if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
      }

      const data = await response.json() as { result: unknown };
      return {
        content: [{ type: "text", text: `Worker Details: ${JSON.stringify(data.result, null, 2)}` }],
        details: { worker: data.result },
      };
    },
  };
}

// Tool: Create a KV namespace
function createCreateKVTool(): AgentTool {
  return {
    name: "create_kv",
    description: "Create a new KV namespace.",
    label: "Create KV",
    parameters: Type.Object({
      title: Type.String({ description: "Title of the KV namespace" }),
    }) as TSchema,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    execute: async (_toolCallId: string, params: Static<TSchema>, _signal?: AbortSignal): Promise<AgentToolResult<any>> => {
      const p = params as CreateKVParams;
      const accountId = getAccountId();
      const response = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces`,
        {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${CLOUDFLARE_API_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ title: p.title }),
        }
      );

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`API error: ${error}`);
      }

      const data = await response.json() as { result: { id: string } };
      return {
        content: [{ type: "text", text: `Created KV namespace: ${data.result.id}` }],
        details: { namespaceId: data.result.id, title: p.title },
      };
    },
  };
}

// Tool: Create a D1 database
function createCreateD1Tool(): AgentTool {
  return {
    name: "create_d1",
    description: "Create a new D1 database.",
    label: "Create D1",
    parameters: Type.Object({
      name: Type.String({ description: "Name of the D1 database" }),
    }) as TSchema,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    execute: async (_toolCallId: string, params: Static<TSchema>, _signal?: AbortSignal): Promise<AgentToolResult<any>> => {
      const p = params as CreateD1Params;
      const accountId = getAccountId();
      const response = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database`,
        {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${CLOUDFLARE_API_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ name: p.name }),
        }
      );

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`API error: ${error}`);
      }

      const data = await response.json() as { result: { uuid: string } };
      return {
        content: [{ type: "text", text: `Created D1 database: ${data.result.uuid}` }],
        details: { databaseId: data.result.uuid, name: p.name },
      };
    },
  };
}

// Tool: List Cloudflare resources
function createListResourcesTool(): AgentTool {
  return {
    name: "list_resources",
    description: "List all Cloudflare resources (Workers, KV, D1, R2, etc.) in your account.",
    label: "List Resources",
    parameters: Type.Object({}) as TSchema,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    execute: async (_toolCallId: string, _params: Static<TSchema>, _signal?: AbortSignal): Promise<AgentToolResult<any>> => {
      const accountId = getAccountId();
      const resources: Record<string, unknown> = {};

      // List Workers
      try {
        const workersRes = await fetch(
          `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers`,
          { headers: { "Authorization": `Bearer ${CLOUDFLARE_API_TOKEN}` } }
        );
        if (workersRes.ok) {
          const workersData = await workersRes.json() as { result: unknown[] };
          resources.workers = workersData.result;
        }
      } catch { /* ignore */ }

      // List KV namespaces
      try {
        const kvRes = await fetch(
          `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces`,
          { headers: { "Authorization": `Bearer ${CLOUDFLARE_API_TOKEN}` } }
        );
        if (kvRes.ok) {
          const kvData = await kvRes.json() as { result: unknown[] };
          resources.kv = kvData.result;
        }
      } catch { /* ignore */ }

      // List D1 databases
      try {
        const d1Res = await fetch(
          `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database`,
          { headers: { "Authorization": `Bearer ${CLOUDFLARE_API_TOKEN}` } }
        );
        if (d1Res.ok) {
          const d1Data = await d1Res.json() as { result: unknown[] };
          resources.d1 = d1Data.result;
        }
      } catch { /* ignore */ }

      return {
        content: [{ type: "text", text: `Resources:\n${JSON.stringify(resources, null, 2)}` }],
        details: { resources },
      };
    },
  };
}

// Helper functions - these would be injected via env in production
let CLOUDFLARE_API_TOKEN = "";
let CLOUDFLARE_ACCOUNT_ID = "";

export function setCloudflareToken(token: string): void {
  CLOUDFLARE_API_TOKEN = token;
}

export function setCloudflareAccountId(accountId: string): void {
  CLOUDFLARE_ACCOUNT_ID = accountId;
}

function getAccountId(): string {
  if (!CLOUDFLARE_ACCOUNT_ID || CLOUDFLARE_ACCOUNT_ID === "YOUR_ACCOUNT_ID") {
    throw new Error("CLOUDFLARE_ACCOUNT_ID is not configured. Set via wrangler secret put CLOUDFLARE_ACCOUNT_ID");
  }
  return CLOUDFLARE_ACCOUNT_ID;
}