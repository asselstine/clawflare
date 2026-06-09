import type { E2ETestContext, E2ETestRunner } from "./support.js";

interface CurrentUserResponse {
  user?: {
    id?: string;
    email?: string;
  };
  workspaces?: Array<{
    id: string;
    slug: string;
    name: string;
    role?: string;
  }>;
  currentWorkspace?: {
    id?: string;
    slug?: string;
    name?: string;
    role?: string;
    defaultModelId?: string;
  };
}

export async function runUserTests(runner: E2ETestRunner, ctx: E2ETestContext): Promise<void> {
  await runner.runTest("Users: get current user and workspace", async () => {
    const data = await ctx.authedJson<CurrentUserResponse>("/v1/users/me");
    if (data.user?.email !== "e2e-test@clawflare.dev") {
      throw new Error(`Expected mock OAuth user, got: ${JSON.stringify(data)}`);
    }
    if (data.currentWorkspace?.slug !== "e2e-test") {
      throw new Error(`Expected current e2e-test workspace, got: ${JSON.stringify(data)}`);
    }
    if (!data.workspaces?.some((workspace) => workspace.id === data.currentWorkspace?.id)) {
      throw new Error(`Current workspace missing from workspace list: ${JSON.stringify(data)}`);
    }
  });
}
