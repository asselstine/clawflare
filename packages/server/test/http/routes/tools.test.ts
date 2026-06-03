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
  it("requires a session to invoke a tool", async () => {
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

    const data = (await response.json()) as { error: string };

    expect(response.status).toBe(400);
    expect(data.error).toBe("Tool execution requires a session");
  });
});
