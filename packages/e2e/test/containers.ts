import type { E2ETestContext, E2ETestRunner, ToolInvokeResponse } from "./support.js";

interface ContainerListResponse {
  containers?: Array<{ id: string }>;
}

interface SessionCreateResponse {
  id?: string;
}

interface DeleteSessionResponse {
  ok?: boolean;
}

interface ContainerBashDetails {
  ok?: boolean;
  pending?: boolean;
  exitCode?: number | null;
  toolRunState?: unknown;
}

async function invokeContainerBash(
  ctx: E2ETestContext,
  sessionId: string,
  input: {
    containerId: string;
    command: string;
    cwd?: string;
    timeoutMs?: number;
    maxOutputChars?: number;
  }
): Promise<ToolInvokeResponse<ContainerBashDetails>> {
  let toolRunState: unknown;
  let latest: ToolInvokeResponse<ContainerBashDetails> | undefined;

  for (let attempt = 0; attempt < 60; attempt++) {
    latest = await ctx.invokeTool<ContainerBashDetails>(
      "container_bash",
      input,
      sessionId,
      toolRunState
    );
    if (!latest.result.details.pending) return latest;
    toolRunState = latest.result.details.toolRunState;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  throw new Error(`Container bash did not complete: ${JSON.stringify(latest)}`);
}

export async function runContainerTests(runner: E2ETestRunner, ctx: E2ETestContext): Promise<void> {
  await runner.runTest("Containers: list workspace and session containers", async () => {
    const workspaceContainers = await ctx.authedJson<ContainerListResponse>("/v1/containers");
    if (!Array.isArray(workspaceContainers.containers)) {
      throw new Error(`Workspace container list should return an array: ${JSON.stringify(workspaceContainers)}`);
    }

    const session = await ctx.authedJson<SessionCreateResponse>("/v1/session", {
      method: "POST",
      body: JSON.stringify({}),
    });
    if (!session.id) throw new Error(`Failed to create session for container list: ${JSON.stringify(session)}`);

    try {
      const sessionContainers = await ctx.authedJson<ContainerListResponse>(`/v1/session/${session.id}/containers`);
      if (!Array.isArray(sessionContainers.containers)) {
        throw new Error(`Session container list should return an array: ${JSON.stringify(sessionContainers)}`);
      }
    } finally {
      const deleted = await ctx.authedJson<DeleteSessionResponse>(`/v1/session/${session.id}`, {
        method: "DELETE",
      });
      if (!deleted.ok) throw new Error(`Failed to delete container list session: ${JSON.stringify(deleted)}`);
    }
  });

  await runner.runTest("Container: create and run ls command", async () => {
    const sessionId = await ctx.createToolSession();
    let containerId: string | undefined;

    try {
      const createData = await ctx.invokeTool<{ containerId?: string; status?: string }>(
        "container_create",
        {},
        sessionId
      );
      containerId = createData.result.details.containerId;
      if (!containerId) throw new Error(`Container create did not return containerId: ${JSON.stringify(createData)}`);
      ctx.trackTestContainer(containerId, sessionId);
      if (createData.result.details.status !== "healthy") throw new Error(`Container not healthy: ${JSON.stringify(createData)}`);

      const bashData = await invokeContainerBash(
        ctx,
        sessionId,
        { containerId, command: "ls -la", cwd: "/workspace" },
      );
      const bashText = bashData.result.content[0]?.text ?? "";
      if (!bashData.result.details.ok) throw new Error(`Bash command failed: ${JSON.stringify(bashData)}`);
      if (bashData.result.details.exitCode !== 0) throw new Error(`Bash command exited with code ${bashData.result.details.exitCode}`);
      if (!bashText.includes("total") || !bashText.includes("workspace")) {
        if (bashText.trim().length === 0) throw new Error("No output from ls command");
      }
    } finally {
      if (containerId) await ctx.destroyTestContainer(containerId, sessionId);
    }
  });

  await runner.runTest("Container: git clone works through GitHub egress", async () => {
    const sessionId = await ctx.createToolSession();
    let containerId: string | undefined;

    try {
      const createData = await ctx.invokeTool<{ containerId?: string; status?: string }>(
        "container_create",
        {},
        sessionId
      );
      containerId = createData.result.details.containerId;
      if (!containerId) throw new Error(`Container create did not return containerId: ${JSON.stringify(createData)}`);
      ctx.trackTestContainer(containerId, sessionId);
      if (createData.result.details.status !== "healthy") throw new Error(`Container not healthy: ${JSON.stringify(createData)}`);

      const cloneCommand = [
        "rm -rf /workspace/test-clone",
        "git clone --depth 1 https://github.com/asselstine/clawflare.git /workspace/test-clone",
        "ls -la /workspace/test-clone/",
      ].join(" && ");

      const bashData = await invokeContainerBash(
        ctx,
        sessionId,
        { containerId, command: cloneCommand, cwd: "/workspace" },
      );
      if (!bashData.result.details.ok || bashData.result.details.exitCode !== 0) {
        throw new Error(`Git clone failed: ${JSON.stringify(bashData)}`);
      }
    } finally {
      if (containerId) await ctx.destroyTestContainer(containerId, sessionId);
    }
  });
}
