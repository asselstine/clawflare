// Clawflare Harness - Main Worker Entry Point
// This runs in Cloudflare Workers and provides an agent powered by pi-agent-core

import { HttpGateway } from "./egress/gateway.js";
import { PersistentSessionWorkflow } from "./runtime/workflow.js";
import { ClawflareWebSocketSession } from "./runtime/ws-session.js";
import { CodingContainer, ContainerProxy } from "./modules/tools/container/coding-container.js";
import app from "./http/app.js";

// Export types for clients (public types only)
export type {
  AgentMessage,
  AgentSession,
  ChatSubmittedResponse,
  ChatRequest,
  SessionResponse,
  SessionSummary,
  SessionEvent,
  SessionListResponse,
} from "./types.js";

// Export public types from data layer
export type {
  SessionMetadataState,
  SessionStatus,
  SessionInputEvent,
  QueueStatus,
  EnqueueResult,
  DequeueResult,
  NewSessionEvent,
  CompleteSessionEvent,
  StoredCodeEntry,
  UpsertStoredCodeParams,
  EgressHandlerMetadata,
  UpsertEgressHandlerParams,
  // Model connection types
  ModelProvider,
  CreateModelConnectionParams,
  UpdateModelConnectionParams,
} from "./data/index.js";

// Export data layer errors
export {
  DataLayerError,
  SessionNotFoundError,
  QueueFullError,
  StoredCodeNotFoundError,
  EgressHandlerNotFoundError,
} from "./data/index.js";

// Export the entrypoints for Cloudflare Workers
export {
  HttpGateway,
  PersistentSessionWorkflow,
  ClawflareWebSocketSession,
  CodingContainer,
  ContainerProxy,
};

// Export Secret Broker as separate entrypoint
export { default as SecretBroker } from "./modules/secrets/secret-broker.worker.js";

export {
  json,
  errorJson,
  notFound,
  badRequest,
  unauthorized,
  forbidden,
  gone,
  tooManyRequests,
  serverError,
  serviceUnavailable,
  payloadTooLarge,
} from "./http/responses.js";

// Export request context utilities
export type { RequestContext } from "./http/request-context.js";
export {
  getBearerToken,
  resolveRequestContext,
  hasPermission,
} from "./http/request-context.js";

// Export agent config utilities
export { normalizeBedrockBearerToken } from "./runtime/agent-config.js";

// Export logger
export { logger, log } from "./lib/logger.js";

// Export auth utilities
export {
  hashPassword,
  verifyPassword,
  validatePasswordStrength,
  normalizeEmail,
  createAccessToken,
  verifyAccessToken,
  revokeAccessToken,
  listAccessTokens,
  createDeviceAuthorization,
  approveDeviceAuthorization,
  denyDeviceAuthorization,
  pollDeviceAuthorization,
  createWebSession,
  verifyWebSession,
  destroyWebSession,
  getSessionCookie,
  getClearSessionCookie,
  extractSessionToken,
  extractCsrfToken,
  createEmailVerificationToken,
  verifyEmailToken,
  createPasswordResetToken,
  verifyPasswordResetToken,
} from "./modules/auth/index.js";

// Export core tools (config-driven tools removed in Phase 4)
export {
  createTools,
  invokeTool,
} from "./modules/tools/tools.service.js";

// Export tool context type
export type { ToolContext } from "./modules/tools/tools.service.js";

// Re-export egress core types for user convenience
export type {
  EgressHandler,
  EgressContext,
  DefineHttpEgressHandlerConfig,
  HttpEgressHandlerContext,
} from "@clawflare/egress-core";

// Export egress handler helpers
export {
  defineEgressHandler,
  defineHttpEgressHandler,
} from "@clawflare/egress-core";

// Export model connection types
export type {
  ModelConnection,
  ModelConnectionListResponse,
} from "./types.js";

// Export model connection service
export {
  createModelConnection,
  updateModelConnection,
  deleteModelConnection,
  resolveModelConnection,
  listModelConnections,
  resolveModelConnectionForSession,
  resolveModelConnectionForNewSession,
  type ResolvedModelConnection,
  type CreateModelConnectionResult,
} from "./modules/model-connections/model-connections.service.js";

// Export provider catalog utilities
export {
  getProviderDefinition,
  getSupportedProviders,
  isProviderSupported,
  requiredSecretsForProvider,
  optionalSecretsForProvider,
  defaultModelForProvider,
  type ProviderDefinition,
} from "./modules/providers/providers.catalog.js";

// Export model connection validation and response helpers
export {
  validateModelConnectionInput,
  redactModelConnection,
  redactModelConnections,
  type ModelConnectionInput,
  type ParsedModelConnection,
  type PublicModelConnection,
} from "./modules/model-connections/model-connections.validation.js";

// Export secret store adapter and authorization types
export {
  createSecretStore,
  getSecretStore,
  type SecretStore,
  type AuthSession,
  type AuthorizationContext,
} from "./data/secrets/index.js";

// Main Cloudflare Worker export
export default {
  async fetch(request: Request, env: unknown, ctx: ExecutionContext): Promise<Response> {
    return app.fetch(request, env as import("./internal-types/index.js").Env, ctx);
  },
};
