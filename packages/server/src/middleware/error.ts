import type { ErrorHandler } from "hono";
import type { AppBindings } from "../http/app-bindings.js";
import { serverError } from "../http/responses.js";
import { logger } from "../lib/logger.js";

export const errorMiddleware: ErrorHandler<AppBindings> = (error) => {
  logger.error("Unhandled HTTP error", error, {
    handler: "errorMiddleware",
  });
  return serverError(error instanceof Error ? error.message : "Internal server error");
};
