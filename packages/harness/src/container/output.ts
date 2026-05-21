/**
 * Output truncation utilities for container tool responses
 */

export const DEFAULT_MAX_OUTPUT_CHARS = 8000;
export const MAX_OUTPUT_CHARS_HARD_LIMIT = 1_000_000;

export interface TruncatedOutput {
  text: string;
  truncated: boolean;
  originalLength: number;
  limit: number;
}

/**
 * Tail-truncate output to fit within limit
 */
export function tailToolOutput(text: string, limit: number): TruncatedOutput {
  if (text.length <= limit) {
    return { text, truncated: false, originalLength: text.length, limit };
  }

  const prefix = `[Tool output truncated. Showing the tail of the response. Original length: ${text.length} characters. Limit: ${limit} characters.]\n`;
  const tailLength = Math.max(0, limit - prefix.length);
  return {
    text: `${prefix}${text.slice(-tailLength)}`,
    truncated: true,
    originalLength: text.length,
    limit,
  };
}

/**
 * Get effective output limit with bounds checking
 */
export function getEffectiveOutputLimit(requestedLimit: number | undefined): number {
  if (requestedLimit === undefined) return DEFAULT_MAX_OUTPUT_CHARS;
  if (!Number.isFinite(requestedLimit) || requestedLimit < 1) {
    throw new Error("maxOutputChars must be a positive number");
  }
  return Math.min(
    Math.floor(requestedLimit), 
    MAX_OUTPUT_CHARS_HARD_LIMIT
  );
}

/**
 * Clamp integer value between min and max
 */
export function clampInt(value: number | undefined, defaultValue: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return defaultValue;
  return Math.min(Math.max(Math.floor(value), min), max);
}

/**
 * Format container result with proper truncation
 */
export interface ContainerResult {
  ok: boolean;
  message?: string;
  details?: unknown;
}

export function formatContainerResult(
  text: string,
  maxOutputChars?: number
): ContainerResult {
  const limit = getEffectiveOutputLimit(maxOutputChars);
  const output = tailToolOutput(text, limit);
  
  return {
    ok: true,
    message: output.text,
    details: {
      truncated: output.truncated,
      originalLength: output.originalLength,
      limit: output.limit,
    },
  };
}

/**
 * Format error result
 */
export function formatContainerError(error: Error | string): ContainerResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    ok: false,
    message,
    details: { error: message },
  };
}
