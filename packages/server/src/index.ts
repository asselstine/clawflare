// Clawflare Harness - Main Worker Entry Point
// This runs in Cloudflare Workers and provides an agent powered by pi-agent-core

import { HttpGateway } from "./egress/gateway.js";
import { PersistentSessionWorkflow } from "./workflow.js";
import { ClawflareWebSocketSession } from "./ws-session.js";
import { CodingContainer, ContainerProxy } from "./container/coding-container.js";
import { handleHttpRequest } from "./http/router.js";

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
  SearchResults,
  SessionRepository,
  SessionEventRepository,
  InputQueueRepository,
  SessionRuntimeRepository,
  StoredCodeRepository,
  EgressHandlerRepository,
  SnapshotRepository,
  DataLayer,
  Datastore,
  // Model connection types
  ModelProvider,
  CreateModelConnectionParams,
  UpdateModelConnectionParams,
  ModelConnectionRepository,
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
export { default as SecretBroker } from "./secret-broker/index.js";

// Export HTTP utilities
export {
  handleHttpRequest,
  normalizePath,
  isRoute,
} from "./http/router.js";

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

// Export canonical data layer accessor
export { getDataLayer } from "./data/index.js";

// Export agent config utilities
export { normalizeBedrockBearerToken } from "./agent-config.js";

// Export diagnostics
export { logTiming, timingStart } from "./diagnostics.js";

// Export logger
export { logger, log } from "./logger.js";

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
} from "./auth/index.js";

// Export core tools (config-driven tools removed in Phase 4)
export {
  createTools,
} from "./tools/index.js";

// Export tool context type
export type { ToolContext } from "./tools/index.js";

// Export simplified server config (internal constants only)
export {
  DEFAULT_AI_PROVIDER,
  DEFAULT_AI_MODEL,
  getAiProvider,
  getAiModel,
} from "./config-api.js";

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
} from "./model-connection-service.js";

// Export model provider utilities
export {
  getProviderDefinition,
  getSupportedProviders,
  isProviderSupported,
  validateModelConnectionInput,
  requiredSecretsForProvider,
  optionalSecretsForProvider,
  defaultModelForProvider,
  redactModelConnection,
  redactModelConnections,
  type PublicModelConnection,
} from "./model-providers.js";

// Export secret store adapter and authorization types
export {
  createSecretStore,
  getSecretStore,
  type SecretStoreAdapter,
  type AuthSession,
  type AuthorizationContext,
} from "./secret-store.js";

// Export Secret Broker types for workflow integration
export type { JobAuthorizationSnapshot } from "./secret-broker/types.js";
export {
  createJobSnapshot,
  getJobSnapshotRepository,
  type JobSnapshotRepository,
} from "./secret-broker/job-snapshot.js";

// Main Cloudflare Worker export
export default {
  async fetch(request: Request, env: unknown, ctx: ExecutionContext): Promise<Response> {
    return handleHttpRequest(request, env as import("./internal-types/index.js").Env, ctx);
  },
};
