// Clawflare Harness - Main Worker Entry Point
// This runs in Cloudflare Workers and provides an agent powered by pi-agent-core

import { HttpGateway } from "./egress/gateway.js";
import { PersistentSessionWorkflow } from "./workflow.js";
import { ClawflareWebSocketSession } from "./ws-session.js";
import { CodingContainer, CodingContainerClass } from "./container/coding-container.js";
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
  CodingContainerClass,
};

// Export HTTP utilities for extension
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

// Export canonical data layer accessor
export { getDataLayer } from "./data/index.js";

// Export agent config utilities
export { normalizeBedrockBearerToken } from "./agent-config.js";

// Export diagnostics
export { logTiming, timingStart } from "./diagnostics.js";

// Export tool factory
export { createTools } from "./tools/index.js";

// Main Cloudflare Worker export
export default {
  async fetch(request: Request, env: unknown, ctx: ExecutionContext): Promise<Response> {
    return handleHttpRequest(request, env as import("./internal-types/index.js").Env, ctx);
  },
};
