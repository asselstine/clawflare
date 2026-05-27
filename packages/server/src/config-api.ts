// Server Configuration - Internal constants only
// This file is intentionally minimal - no public config API

/**
 * Default AI provider configuration
 * DEPRECATED: Model configurations now come from workspace model connections
 */
export const DEFAULT_AI_PROVIDER = "amazon-bedrock";

/**
 * Default AI model
 * DEPRECATED: Model configurations now come from workspace model connections
 */
export const DEFAULT_AI_MODEL = "minimax.minimax-m2.5";

/**
 * Get AI provider from environment or use default
 * DEPRECATED: Use model connection from session instead
 * @deprecated
 */
export function getAiProvider(): string {
  return DEFAULT_AI_PROVIDER;
}

/**
 * Get AI model from environment or use default
 * DEPRECATED: Use model connection from session instead
 * @deprecated
 */
export function getAiModel(): string {
  return DEFAULT_AI_MODEL;
}
