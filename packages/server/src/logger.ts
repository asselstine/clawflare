/**
 * Structured logging for Clawflare server
 * All logs are output as JSON for easy parsing
 */

type LogLevel = "debug" | "info" | "warn" | "error";

type LogContext = Record<string, unknown>;

export function log(level: LogLevel, message: string, context: LogContext = {}): void {
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

export const logger = {
  debug: (message: string, context?: LogContext) => log("debug", message, context),
  info: (message: string, context?: LogContext) => log("info", message, context),
  warn: (message: string, context?: LogContext) => log("warn", message, context),
  error: (message: string, context?: LogContext) => log("error", message, context),
  log,
};

export default logger;
