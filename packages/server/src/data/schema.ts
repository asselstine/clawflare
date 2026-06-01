import { sql } from "drizzle-orm";
import {
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  displayName: text("display_name"),
  emailVerifiedAt: integer("email_verified_at"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const workspaces = sqliteTable("workspaces", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  description: text("description"),
  defaultModelConnectionId: text("default_model_connection_id"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

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
  })
);

export const oauthAccounts = sqliteTable("oauth_accounts", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),
  providerAccountId: text("provider_account_id").notNull(),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  expiresAt: integer("expires_at"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const passwordCredentials = sqliteTable("password_credentials", {
  userId: text("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  passwordHash: text("password_hash").notNull(),
  passwordUpdatedAt: integer("password_updated_at").notNull(),
});

export const webSessions = sqliteTable("web_sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  sessionTokenHash: text("session_token_hash").notNull().unique(),
  csrfTokenHash: text("csrf_token_hash").notNull(),
  expiresAt: integer("expires_at").notNull(),
  createdAt: integer("created_at").notNull(),
  lastSeenAt: integer("last_seen_at"),
});

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
});

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
  accessTokenPlaintext: text("access_token_plaintext"),
  tokenRetrievedAt: integer("token_retrieved_at"),
});

export const emailVerificationTokens = sqliteTable("email_verification_tokens", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: integer("expires_at").notNull(),
  consumedAt: integer("consumed_at"),
  createdAt: integer("created_at").notNull(),
});

export const passwordResetTokens = sqliteTable("password_reset_tokens", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: integer("expires_at").notNull(),
  consumedAt: integer("consumed_at"),
  createdAt: integer("created_at").notNull(),
});

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
  modelConnectionId: text("model_connection_id"),
  modelProvider: text("model_provider"),
  modelName: text("model_name"),
});

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
  })
);

export const sessionCounters = sqliteTable("session_counters", {
  sessionId: text("session_id").primaryKey().references(() => sessions.id, { onDelete: "cascade" }),
  workspaceId: text("workspace_id"),
  nextQueueSequence: integer("next_queue_sequence").notNull().default(1),
  nextEventSequence: integer("next_event_sequence").notNull().default(1),
  updatedAt: integer("updated_at").notNull(),
});

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
  })
);

export const sessionRuntime = sqliteTable("session_runtime", {
  sessionId: text("session_id").primaryKey().references(() => sessions.id, { onDelete: "cascade" }),
  workspaceId: text("workspace_id"),
  active: integer("active").notNull().default(0),
  workflowSessionJson: text("workflow_session_json"),
  snapshotJson: text("snapshot_json"),
  updatedAt: integer("updated_at").notNull(),
});

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
  })
);

export const egressHandlers = sqliteTable("egress_handlers", {
  name: text("name").primaryKey(),
  workspaceId: text("workspace_id"),
  description: text("description").notNull(),
  domainsJson: text("domains_json").notNull(),
  enabled: integer("enabled").notNull().default(1),
  configJson: text("config_json").notNull().default(sql`'{}'`),
  updatedAt: integer("updated_at").notNull(),
});

export const modelConnections = sqliteTable("model_connections", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  displayName: text("display_name"),
  provider: text("provider").notNull(),
  modelName: text("model_name").notNull(),
  secretRefsJson: text("secret_refs_json").notNull().default(sql`'{}'`),
  configJson: text("config_json").notNull().default(sql`'{}'`),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  deletedAt: integer("deleted_at"),
});

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
  })
);
