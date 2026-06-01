import { describe, expect, it } from "vitest";
import { handleInvokeTool } from "../../../src/modules/tools/tools.routes.js";
import type { Env } from "../../../src/internal-types/index.js";
import type { RequestContext } from "../../../src/http/request-context.js";
import type { Workspace } from "../../../src/data/index.js";

function createRequestContext(): RequestContext {
  const workspace: Workspace = {
    id: "test-workspace",
    slug: "test",
    name: "Test Workspace",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  return {
    user: {
      id: "test-user",
      email: "test@example.com",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
    workspace,
    role: "owner",
  };
}

describe("tools routes", () => {
  it("invokes a tool by name", async () => {
    const response = await handleInvokeTool(
      new Request("https://example.com/v1/tools/search", {
        method: "POST",
        body: JSON.stringify({
          input: {
            collection: "stored_code",
            query: "anything",
          },
        }),
      }),
      {
        DB: {
          prepare: () => ({
            bind: () => ({
              all: () => Promise.resolve({ results: [] }),
            }),
          }),
        },
      } as unknown as Env,
      {} as ExecutionContext,
      createRequestContext(),
      "search"
    );

    const data = (await response.json()) as {
      tool: string;
      result: {
        details: {
          storedCode: unknown[];
          workspaceId: string;
        };
      };
    };

    expect(response.status).toBe(200);
    expect(data.tool).toBe("search");
    expect(data.result.details.storedCode).toEqual([]);
    expect(data.result.details.workspaceId).toBe("test-workspace");
  });
});
