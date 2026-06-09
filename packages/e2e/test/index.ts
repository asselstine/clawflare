import { runAuthTests } from "./auth.js";
import { runContainerTests } from "./containers.js";
import { runEgressTests } from "./egress.js";
import { runModelTests } from "./models.js";
import { runProviderTests } from "./providers.js";
import { runSessionTests } from "./sessions.js";
import { runToolTests } from "./tools.js";
import { runUserTests } from "./users.js";
import { runWorkspaceTests } from "./workspace.js";
import type { E2ETestContext, E2ETestRunner } from "./support.js";

export async function runE2ETests(runner: E2ETestRunner, ctx: E2ETestContext): Promise<void> {
  await runAuthTests(runner, ctx);
  await runUserTests(runner, ctx);
  await runWorkspaceTests(runner, ctx);
  await runProviderTests(runner, ctx);
  await runModelTests(runner, ctx);
  await runSessionTests(runner, ctx);
  await runToolTests(runner, ctx);
  await runEgressTests(runner, ctx);
  await runContainerTests(runner, ctx);
}
