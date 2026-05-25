// Server Configuration - Internal constants only
// This file is intentionally minimal - no public config API

import type { Env } from "./internal-types/index.js";

/**
 * Default AI provider configuration
 */
export const DEFAULT_AI_PROVIDER = "amazon-bedrock";

/**
 * Default AI model
 */
export const DEFAULT_AI_MODEL = "minimax.minimax-m2.5";

/**
 * Get AI provider from environment or use default
 */
export function getAiProvider(env: Env): string {
  return env.AI_PROVIDER ?? DEFAULT_AI_PROVIDER;
}

/**
 * Get AI model from environment or use default
 */
export function getAiModel(env: Env): string {
  return env.AI_MODEL ?? DEFAULT_AI_MODEL;
}
