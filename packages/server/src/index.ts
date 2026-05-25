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

export {
  getBearerToken,
  validateHarnessToken,
  validateHarnessConfigured,
  isAuthenticated,
} from "./http/auth.js";

// Export request context utilities
export type { RequestContext } from "./http/request-context.js";
export {
  resolveRequestContext,
  hasPermission,
} from "./http/request-context.js";

// Export canonical data layer accessor
export { getDataLayer } from "./data/index.js";

// Export agent config utilities
export { normalizeBedrockBearerToken } from "./agent-config.js";

// Export diagnostics
export { logTiming, timingStart } from "./diagnostics.js";

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

// Main Cloudflare Worker export
export default {
  async fetch(request: Request, env: unknown, ctx: ExecutionContext): Promise<Response> {
    return handleHttpRequest(request, env as import("./internal-types/index.js").Env, ctx);
  },
};
