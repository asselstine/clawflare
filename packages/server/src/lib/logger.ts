/**
 * Structured logging for Clawflare server
 * All logs are output as JSON for easy parsing
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogContext = Record<string, unknown>;

export interface SerializedError {
  name?: string;
  message: string;
  stack?: string;
  cause?: SerializedError | string;
}

/**
 * Serialize an unknown error value into a structured error object.
 * Preserves Error properties including the cause chain.
 */
export function serializeError(error: unknown): SerializedError {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      cause:
        error.cause === undefined
          ? undefined
          : error.cause instanceof Error
            ? serializeError(error.cause)
            : String(error.cause),
    };
  }

  return {
    message: String(error),
  };
}

/**
 * Extract an error message from an unknown value.
 * Returns the error message if it's an Error, otherwise stringifies the value.
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function write(level: LogLevel, message: string, context: LogContext = {}): void {
  const entry = JSON.stringify({
    level,
    message,
    ...context,
    timestamp: new Date().toISOString(),
  });

  switch (level) {
    case "error":
      console.error(entry);
      break;
    case "warn":
      console.warn(entry);
      break;
    default:
      console.log(entry);
  }
}

/**
 * Structured logger with first-class error handling.
 * 
 * The error method accepts:
 * - logger.error("message", error) - logs error with serialized stack trace
 * - logger.error("message", error, context) - logs error with additional context
 * - logger.error("message", context) - legacy API (deprecated, use logger.error without error for context-only)
 */
export const logger = {
  debug: (message: string, context?: LogContext) => write("debug", message, context),
  info: (message: string, context?: LogContext) => write("info", message, context),
  warn: (message: string, context?: LogContext) => write("warn", message, context),

  /**
   * Log an error with optional error object and context.
   * 
   * Recommended: logger.error("Workflow prompt failed", error, { sessionId })
   * Legacy: logger.error("Message", { some: "context" }) - also supported
   */
  error: (message: string, error?: unknown, context: LogContext = {}): void => {
    // If second argument is a Record (context, not an error), handle as legacy call
    if (error !== undefined && typeof error === "object" && 
        !(error instanceof Error) && 
        !(error instanceof Array)) {
      write("error", message, error as LogContext);
      return;
    }

    write("error", message, {
      ...context,
      ...(error === undefined ? {} : { error: serializeError(error) }),
    });
  },

  log: write,
};

/**
 * Direct log function for custom level control.
 * @deprecated Use logger.info/debug/warn/error instead.
 */
export function log(level: LogLevel, message: string, context: LogContext = {}): void {
  write(level, message, context);
}

export default logger;
