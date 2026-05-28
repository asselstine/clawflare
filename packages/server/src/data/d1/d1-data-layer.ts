// D1 Data Layer Factory
// Creates a complete DataLayer backed by Cloudflare D1

import type { DataLayer, SearchResults } from "../interfaces.js";
import { D1SessionRepository } from "./d1-sessions.js";
import { D1SessionEventRepository } from "./d1-session-events.js";
import { D1InputQueueRepository } from "./d1-input-queue.js";
import { D1SessionRuntimeRepository } from "./d1-runtime-state.js";
import { D1StoredCodeRepository } from "./d1-stored-code.js";
import { D1EgressHandlerRepository } from "./d1-egress-handlers.js";
import { D1SnapshotRepository } from "./d1-snapshots.js";
import { D1WorkspaceRepository, D1UserRepository } from "./d1-workspaces.js";
import { D1ModelConnectionRepository } from "./d1-model-connections.js";
import { D1JobSnapshotRepository } from "./job-snapshots.js";
import {
  D1AccessTokenRepository,
  D1WebSessionRepository,
  D1EmailVerificationTokenRepository,
  D1PasswordResetTokenRepository,
  D1DeviceAuthorizationRepository,
} from "./d1-auth.js";
import type {
  AccessTokenRepository,
  WebSessionRepository,
  EmailVerificationTokenRepository,
  PasswordResetTokenRepository,
  DeviceAuthorizationRepository,
} from "../auth.js";

import type { UserRepository } from "../workspaces.js";

/**
 * Extended DataLayer interface including job snapshots, auth repositories, and users
 */
export interface D1DataLayer extends DataLayer {
  jobSnapshots: D1JobSnapshotRepository;
  users: UserRepository;
  accessTokens: AccessTokenRepository;
  webSessions: WebSessionRepository;
  emailVerificationTokens: EmailVerificationTokenRepository;
  passwordResetTokens: PasswordResetTokenRepository;
  deviceAuthorizations: DeviceAuthorizationRepository;
}

/**
 * Create a DataLayer backed by D1
 */
export function createD1DataLayer(db: D1Database): D1DataLayer {
  const storedCode = new D1StoredCodeRepository(db);
  const egressHandlers = new D1EgressHandlerRepository(db);
  const workspaces = new D1WorkspaceRepository(db);

  return {
    sessions: new D1SessionRepository(db),
    events: new D1SessionEventRepository(db),
    inputQueue: new D1InputQueueRepository(db),
    runtime: new D1SessionRuntimeRepository(db),
    storedCode,
    egressHandlers,
    workspaces,
    users: new D1UserRepository(db),
    snapshots: new D1SnapshotRepository(db),
    modelConnections: new D1ModelConnectionRepository(db),
    jobSnapshots: new D1JobSnapshotRepository(db),
    accessTokens: new D1AccessTokenRepository(db),
    webSessions: new D1WebSessionRepository(db),
    emailVerificationTokens: new D1EmailVerificationTokenRepository(db),
    passwordResetTokens: new D1PasswordResetTokenRepository(db),
    deviceAuthorizations: new D1DeviceAuthorizationRepository(db),

    async search(workspaceId: string, query: string, limit: number): Promise<SearchResults> {
      const [storedCodeResults, egressResults] = await Promise.all([
        storedCode.search(workspaceId, query, limit),
        egressHandlers.search(workspaceId, query, limit),
      ]);

      return {
        storedCode: storedCodeResults,
        egressHandlers: egressResults,
      };
    },
  };
}

/**
 * Re-export repository classes for testing
 */
export {
  D1SessionRepository,
  D1SessionEventRepository,
  D1InputQueueRepository,
  D1SessionRuntimeRepository,
  D1StoredCodeRepository,
  D1EgressHandlerRepository,
  D1SnapshotRepository,
  D1WorkspaceRepository,
  D1UserRepository,
  D1ModelConnectionRepository,
  D1JobSnapshotRepository,
  D1AccessTokenRepository,
  D1WebSessionRepository,
  D1EmailVerificationTokenRepository,
  D1PasswordResetTokenRepository,
  D1DeviceAuthorizationRepository,
};
