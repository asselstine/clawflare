import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  displayName: text("display_name"),
  emailVerifiedAt: integer("email_verified_at"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (table) => ({
  email: index("idx_users_email").on(table.email),
}));

export const workspaces = sqliteTable("workspaces", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  description: text("description"),
  defaultModelId: text("default_model_id"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (table) => ({
  slug: index("idx_workspaces_slug").on(table.slug),
  updated: index("idx_workspaces_updated").on(sql`${table.updatedAt} DESC`),
}));

export const workspaceMemberships = sqliteTable(
  "workspace_memberships",
  {
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["owner", "admin", "member", "viewer"] }).notNull(),
    joinedAt: integer("joined_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.workspaceId, table.userId] }),
    user: index("idx_workspace_memberships_user").on(table.userId),
    workspace: index("idx_workspace_memberships_workspace").on(table.workspaceId),
  })
);

export const oauthAccounts = sqliteTable(
  "oauth_accounts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    providerAccountId: text("provider_account_id").notNull(),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    expiresAt: integer("expires_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => ({
    user: index("idx_oauth_accounts_user").on(table.userId),
    provider: index("idx_oauth_accounts_provider").on(table.provider, table.providerAccountId),
  })
);

export const passwordCredentials = sqliteTable("password_credentials", {
  userId: text("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  passwordHash: text("password_hash").notNull(),
  passwordUpdatedAt: integer("password_updated_at").notNull(),
}, (table) => ({
  updated: index("idx_password_credentials_updated").on(table.passwordUpdatedAt),
}));

export const webSessions = sqliteTable("web_sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  sessionTokenHash: text("session_token_hash").notNull().unique(),
  csrfTokenHash: text("csrf_token_hash").notNull(),
  expiresAt: integer("expires_at").notNull(),
  createdAt: integer("created_at").notNull(),
  lastSeenAt: integer("last_seen_at"),
}, (table) => ({
  user: index("idx_web_sessions_user_id").on(table.userId),
  sessionTokenHash: index("idx_web_sessions_token_hash").on(table.sessionTokenHash),
  expiresAt: index("idx_web_sessions_expires_at").on(table.expiresAt),
}));

export const accessTokens = sqliteTable("access_tokens", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  name: text("name").notNull(),
  clientName: text("client_name"),
  expiresAt: integer("expires_at"),
  createdAt: integer("created_at").notNull(),
  lastUsedAt: integer("last_used_at"),
  revokedAt: integer("revoked_at"),
}, (table) => ({
  user: index("idx_access_tokens_user_id").on(table.userId),
  tokenHash: index("idx_access_tokens_token_hash").on(table.tokenHash),
  revoked: index("idx_access_tokens_revoked").on(table.revokedAt),
}));

export const deviceAuthorizations = sqliteTable("device_authorizations", {
  deviceCode: text("device_code").primaryKey(),
  userCode: text("user_code").notNull().unique(),
  clientName: text("client_name").notNull(),
  userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
  accessTokenId: text("access_token_id").references(() => accessTokens.id, { onDelete: "set null" }),
  status: text("status", { enum: ["pending", "approved", "denied", "expired"] }).notNull(),
  expiresAt: integer("expires_at").notNull(),
  approvedAt: integer("approved_at"),
  createdAt: integer("created_at").notNull(),
  oauthStateHash: text("oauth_state_hash"),
  returnUrl: text("return_url"),
  accessTokenPlaintext: text("access_token_plaintext"),
  tokenRetrievedAt: integer("token_retrieved_at"),
}, (table) => ({
  userCode: index("idx_device_authorizations_user_code").on(table.userCode),
  user: index("idx_device_authorizations_user_id").on(table.userId),
  expiresAt: index("idx_device_authorizations_expires_at").on(table.expiresAt),
  status: index("idx_device_authorizations_status").on(table.status),
  oauthStateHash: index("idx_device_authorizations_oauth_state_hash").on(table.oauthStateHash),
}));

export const emailVerificationTokens = sqliteTable("email_verification_tokens", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: integer("expires_at").notNull(),
  consumedAt: integer("consumed_at"),
  createdAt: integer("created_at").notNull(),
}, (table) => ({
  user: index("idx_email_verification_tokens_user_id").on(table.userId),
  tokenHash: index("idx_email_verification_tokens_hash").on(table.tokenHash),
}));

export const passwordResetTokens = sqliteTable("password_reset_tokens", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: integer("expires_at").notNull(),
  consumedAt: integer("consumed_at"),
  createdAt: integer("created_at").notNull(),
}, (table) => ({
  user: index("idx_password_reset_tokens_user_id").on(table.userId),
  tokenHash: index("idx_password_reset_tokens_hash").on(table.tokenHash),
}));

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  workflowId: text("workflow_id").notNull(),
  workspaceId: text("workspace_id"),
  name: text("name"),
  status: text("status", {
    enum: ["idle", "processing", "awaiting_input", "error", "closed", "expired"],
  }).notNull(),
  nextEventCursor: integer("next_event_cursor").notNull().default(0),
  updatedAt: integer("updated_at").notNull(),
  errorMessage: text("error_message"),
  maxQueueSize: integer("max_queue_size").notNull().default(100),
  idleTimeout: text("idle_timeout"),
  modelId: text("model_id"),
}, (table) => ({
  statusUpdated: index("idx_sessions_status_updated").on(table.status, sql`${table.updatedAt} DESC`),
  updated: index("idx_sessions_updated").on(sql`${table.updatedAt} DESC`),
  workflow: index("idx_sessions_workflow").on(table.workflowId),
  workspace: index("idx_sessions_workspace").on(table.workspaceId),
  workspaceUpdated: index("idx_sessions_workspace_updated").on(table.workspaceId, sql`${table.updatedAt} DESC`),
}));

export const sessionEvents = sqliteTable(
  "session_events",
  {
    sessionId: text("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    workspaceId: text("workspace_id"),
    timestamp: integer("timestamp").notNull(),
    type: text("type").notNull(),
    payloadJson: text("payload_json").notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.sessionId, table.sequence] }),
    sessionSequence: index("idx_session_events_session_sequence").on(table.sessionId, table.sequence),
    type: index("idx_session_events_type").on(table.type),
    timestamp: index("idx_session_events_timestamp").on(table.timestamp),
    workspace: index("idx_session_events_workspace").on(table.workspaceId),
    workspaceSession: index("idx_session_events_workspace_session").on(table.workspaceId, table.sessionId),
  })
);

/**
 * Durable, user-facing conversation state for a session.
 *
 * Messages are the source of truth for API clients and UI rendering. A session
 * is an ordered list of messages; each message has typed content blocks such as
 * text and tool calls. Tool results are attached to the tool_call block they
 * complete, so clients can render tool output underneath the call without
 * reconstructing relationships from separate runtime events.
 *
 * session_events stores replayable message deltas. Replaying those deltas from
 * an empty message list must reconstruct this table exactly. The runtime may
 * still keep workflow snapshots for execution, but those snapshots are not the
 * public conversation model.
 */
export const sessionMessages = sqliteTable(
  "session_messages",
  {
    sessionId: text("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    workspaceId: text("workspace_id"),
    id: text("id").notNull(),
    role: text("role", { enum: ["user", "assistant", "system"] }).notNull(),
    status: text("status", { enum: ["queued", "streaming", "complete", "error"] }).notNull(),
    contentJson: text("content_json").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.sessionId, table.sequence] }),
    sessionSequence: index("idx_session_messages_session_sequence").on(table.sessionId, table.sequence),
    sessionMessageId: uniqueIndex("idx_session_messages_session_id_unique").on(table.sessionId, table.id),
    sessionId: index("idx_session_messages_session_id").on(table.sessionId, table.id),
    workspace: index("idx_session_messages_workspace").on(table.workspaceId),
    workspaceSession: index("idx_session_messages_workspace_session").on(table.workspaceId, table.sessionId),
  })
);

export const sessionCounters = sqliteTable("session_counters", {
  sessionId: text("session_id").primaryKey().references(() => sessions.id, { onDelete: "cascade" }),
  workspaceId: text("workspace_id"),
  nextQueueSequence: integer("next_queue_sequence").notNull().default(1),
  nextEventSequence: integer("next_event_sequence").notNull().default(1),
  nextMessageSequence: integer("next_message_sequence").notNull().default(1),
  updatedAt: integer("updated_at").notNull(),
}, (table) => ({
  workspace: index("idx_session_counters_workspace").on(table.workspaceId),
}));

export const sessionInputQueue = sqliteTable(
  "session_input_queue",
  {
    sessionId: text("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    workspaceId: text("workspace_id"),
    eventJson: text("event_json").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.sessionId, table.sequence] }),
    sessionSequence: index("idx_session_input_queue_session_sequence").on(table.sessionId, table.sequence),
    workspace: index("idx_session_input_queue_workspace").on(table.workspaceId),
  })
);

export const sessionRuntime = sqliteTable("session_runtime", {
  sessionId: text("session_id").primaryKey().references(() => sessions.id, { onDelete: "cascade" }),
  workspaceId: text("workspace_id"),
  active: integer("active").notNull().default(0),
  workflowSessionJson: text("workflow_session_json"),
  snapshotJson: text("snapshot_json"),
  workflowWaitingAt: integer("workflow_waiting_at"),
  hotContextJson: text("hot_context_json"),
  updatedAt: integer("updated_at").notNull(),
}, (table) => ({
  active: index("idx_session_runtime_active").on(table.active),
  workspace: index("idx_session_runtime_workspace").on(table.workspaceId),
}));

export const sessionRuns = sqliteTable("session_runs", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
  workspaceId: text("workspace_id"),
  status: text("status", {
    enum: ["runnable", "running", "completed", "error", "cancel_requested", "cancelled"],
  }).notNull(),
  inputJson: text("input_json").notNull(),
  attempt: integer("attempt").notNull().default(0),
  leaseOwner: text("lease_owner"),
  leaseExpiresAt: integer("lease_expires_at"),
  stepCursor: integer("step_cursor").notNull().default(0),
  errorMessage: text("error_message"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (table) => ({
  sessionStatus: index("idx_session_runs_session_status").on(table.sessionId, table.status),
  statusUpdated: index("idx_session_runs_status_updated").on(table.status, table.updatedAt),
  lease: index("idx_session_runs_lease").on(table.status, table.leaseExpiresAt),
}));

export const sessionRunSteps = sqliteTable(
  "session_run_steps",
  {
    runId: text("run_id").notNull().references(() => sessionRuns.id, { onDelete: "cascade" }),
    stepName: text("step_name").notNull(),
    status: text("status", { enum: ["completed"] }).notNull(),
    resultJson: text("result_json").notNull(),
    attempt: integer("attempt").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.runId, table.stepName] }),
  })
);

export const sessionTools = sqliteTable(
  "session_tools",
  {
    sessionId: text("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
    toolRefType: text("tool_ref_type", { enum: ["builtin", "custom"] }).notNull(),
    toolRef: text("tool_ref").notNull(),
    enabled: integer("enabled").notNull().default(1),
    configJson: text("config_json").notNull().default(sql`'{}'`),
    pinnedVersionId: text("pinned_version_id"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.sessionId, table.toolRefType, table.toolRef] }),
    sessionEnabled: index("idx_session_tools_session_enabled").on(table.sessionId, table.enabled),
  })
);

export const containers = sqliteTable(
  "containers",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    status: text("status", { enum: ["active", "destroyed"] }).notNull().default("active"),
    description: text("description"),
    lastActivityAt: integer("last_activity_at").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    deletedAt: integer("deleted_at"),
  },
  (table) => ({
    workspace: index("idx_containers_workspace").on(table.workspaceId, table.deletedAt, sql`${table.updatedAt} DESC`),
    workspaceName: uniqueIndex("idx_containers_workspace_name").on(table.workspaceId, table.name),
    status: index("idx_containers_status").on(table.status),
  })
);

export const sessionContainer = sqliteTable(
  "session_container",
  {
    sessionId: text("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
    containerId: text("container_id").notNull().references(() => containers.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["default", "attached"] }).notNull().default("attached"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.sessionId, table.containerId] }),
    session: index("idx_session_container_session").on(table.workspaceId, table.sessionId),
    container: index("idx_session_container_container").on(table.workspaceId, table.containerId),
  })
);

export const storedCode = sqliteTable(
  "stored_code",
  {
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    code: text("code").notNull(),
    description: text("description"),
    tagsJson: text("tags_json").notNull().default(sql`'[]'`),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.workspaceId, table.name] }),
    workspaceUpdated: index("idx_stored_code_workspace_updated").on(table.workspaceId, sql`${table.updatedAt} DESC`),
    workspaceName: index("idx_stored_code_workspace_name").on(table.workspaceId, table.name),
  })
);

export const egressHandlers = sqliteTable(
  "egress_handlers",
  {
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    egressHandlerId: text("egress_handler_id").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    domainsJson: text("domains_json").notNull(),
    enabled: integer("enabled").notNull().default(1),
    secretRefsJson: text("secret_refs_json").notNull().default(sql`'{}'`),
    configJson: text("config_json").notNull().default(sql`'{}'`),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.workspaceId, table.egressHandlerId] }),
    enabled: index("idx_egress_handlers_enabled").on(table.enabled),
    id: index("idx_egress_handlers_id").on(table.egressHandlerId),
    name: index("idx_egress_handlers_name").on(table.name),
    updated: index("idx_egress_handlers_updated").on(sql`${table.updatedAt} DESC`),
    workspace: index("idx_egress_handlers_workspace").on(table.workspaceId),
    workspaceEnabled: index("idx_egress_handlers_workspace_enabled").on(table.workspaceId, table.enabled),
  })
);

export const providers = sqliteTable("providers", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  displayName: text("display_name"),
  provider: text("provider").notNull(),
  secretRefsJson: text("secret_refs_json").notNull().default(sql`'{}'`),
  configJson: text("config_json").notNull().default(sql`'{}'`),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  deletedAt: integer("deleted_at"),
}, (table) => ({
  workspace: index("idx_providers_workspace").on(table.workspaceId, table.deletedAt, sql`${table.updatedAt} DESC`),
  provider: index("idx_providers_provider").on(table.provider),
}));

export const models = sqliteTable("models", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  providerId: text("provider_id").notNull().references(() => providers.id, { onDelete: "cascade" }),
  displayName: text("display_name"),
  modelName: text("model_name").notNull(),
  configJson: text("config_json").notNull().default(sql`'{}'`),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  deletedAt: integer("deleted_at"),
}, (table) => ({
  workspace: index("idx_models_workspace").on(table.workspaceId, table.deletedAt, sql`${table.updatedAt} DESC`),
  provider: index("idx_models_provider").on(table.providerId, table.modelName),
}));

export const encryptedSecrets = sqliteTable(
  "encrypted_secrets",
  {
    workspaceId: text("workspace_id").notNull(),
    key: text("key").notNull(),
    v: integer("v").notNull(),
    edek: text("edek").notNull(),
    ct: text("ct").notNull(),
    nonce: text("nonce").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.workspaceId, table.key] }),
    workspace: index("idx_encrypted_secrets_workspace").on(table.workspaceId, sql`${table.updatedAt} DESC`),
  })
);
