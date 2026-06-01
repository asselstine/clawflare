import type { Env } from "../internal-types/index.js";
import type { RequestContext } from "./request-context.js";

type AppVariables = {
  requestContext?: RequestContext;
};

export type AppBindings = {
  Bindings: Env;
  Variables: AppVariables;
};
